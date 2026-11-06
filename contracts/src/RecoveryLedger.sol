// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RedressVault} from "./RedressVault.sol";

/// @notice Tracks what each paid redress is owed back by the liquidator and block builder that
/// benefited, and refills the vault when funds arrive.
/// @dev A claim is a public record, not an enforcement mechanism: nothing here can take funds
/// from a liquidator or builder. Recovery depends on them, or someone else, paying in.
///
/// Trust: the attestor supplies the two addresses, which are public facts of the mainnet block
/// that this chain cannot see. The expected amount comes from the vault, not the attestor.
contract RecoveryLedger is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Claim {
        address liquidator;
        address builder;
        uint256 expected;
        uint256 recovered;
    }

    error InvalidConfig();
    error OnlyAttestor();
    error NotPaid();
    error ClaimExists();
    error NoClaim();
    error InvalidBeneficiary();
    error ZeroAmount();
    error AlreadySettled();

    event ClaimOpened(
        bytes32 indexed liquidationTx, uint32 logIndex, address indexed liquidator, address indexed builder, uint256 expected
    );
    event RecoveryReceived(bytes32 indexed liquidationTx, uint32 logIndex, address indexed from, uint256 amount);
    event ClaimSettled(bytes32 indexed liquidationTx, uint32 logIndex);

    RedressVault public immutable vault;
    IERC20 public immutable asset;
    address public immutable attestor;

    uint256 public totalExpected;
    uint256 public totalRecovered;

    mapping(bytes32 key => Claim claim) private claims;

    constructor(RedressVault vault_, address attestor_) {
        if (address(vault_) == address(0) || attestor_ == address(0)) revert InvalidConfig();
        vault = vault_;
        asset = vault_.payoutAsset();
        attestor = attestor_;
    }

    function claimOf(bytes32 liquidationTx, uint32 logIndex) external view returns (Claim memory) {
        return claims[_key(liquidationTx, logIndex)];
    }

    /// @notice Opens a claim for the redress the vault paid. Write-once.
    function openClaim(bytes32 liquidationTx, uint32 logIndex, address liquidator, address builder) external {
        if (msg.sender != attestor) revert OnlyAttestor();
        if (liquidator == address(0)) revert InvalidBeneficiary();
        RedressVault.Record memory record = vault.recordOf(liquidationTx, logIndex);
        if (!record.paid) revert NotPaid();

        Claim storage c = claims[_key(liquidationTx, logIndex)];
        if (c.expected != 0) revert ClaimExists();
        c.liquidator = liquidator;
        c.builder = builder;
        c.expected = record.redress;
        totalExpected += record.redress;
        emit ClaimOpened(liquidationTx, logIndex, liquidator, builder, record.redress);
    }

    /// @notice Pays toward a claim and re-credits the vault. Anyone may call it, and an amount
    /// above what is outstanding is reduced to it.
    function receiveRecovery(bytes32 liquidationTx, uint32 logIndex, uint256 amount)
        external
        nonReentrant
        returns (uint256 accepted)
    {
        if (amount == 0) revert ZeroAmount();
        Claim storage c = claims[_key(liquidationTx, logIndex)];
        if (c.expected == 0) revert NoClaim();
        uint256 outstanding = c.expected - c.recovered;
        if (outstanding == 0) revert AlreadySettled();

        accepted = amount < outstanding ? amount : outstanding;
        c.recovered += accepted;
        totalRecovered += accepted;

        asset.safeTransferFrom(msg.sender, address(this), accepted);
        asset.forceApprove(address(vault), accepted);
        vault.fund(accepted);

        emit RecoveryReceived(liquidationTx, logIndex, msg.sender, accepted);
        if (c.recovered == c.expected) emit ClaimSettled(liquidationTx, logIndex);
    }

    function _key(bytes32 liquidationTx, uint32 logIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(liquidationTx, logIndex));
    }
}
