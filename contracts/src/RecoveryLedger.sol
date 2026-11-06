// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRecoveryLedger} from "./interfaces/IAccountability.sol";

interface IVaultFund {
    function fund(uint256 amount) external;
}

/// @notice Records what each payout is owed back by the liquidator and block builder that
/// benefited, and refills the reserve when funds arrive.
/// @dev A claim is a public record, not enforcement: nothing here can take funds from anyone.
/// Recovery depends on someone paying in. The addresses come from the report.
contract RecoveryLedger is IRecoveryLedger, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Claim {
        address liquidator;
        address builder;
        uint256 expected;
        uint256 recovered;
    }

    error InvalidConfig();
    error OnlyVault();
    error NoClaim();
    error ZeroAmount();
    error AlreadySettled();

    event ClaimOpened(
        bytes32 indexed liquidationTx,
        uint32 logIndex,
        address indexed liquidator,
        address indexed builder,
        uint256 expected
    );
    event RecoveryReceived(bytes32 indexed liquidationTx, uint32 logIndex, address indexed from, uint256 amount);
    event ClaimSettled(bytes32 indexed liquidationTx, uint32 logIndex);

    address public immutable vault;
    address public immutable asset;

    uint256 public totalExpected;
    uint256 public totalRecovered;

    mapping(bytes32 key => Claim claim) private claims;

    constructor(address vault_, address asset_) {
        if (vault_ == address(0) || asset_ == address(0)) revert InvalidConfig();
        vault = vault_;
        asset = asset_;
    }

    function claimOf(bytes32 liquidationTx, uint32 logIndex) external view returns (Claim memory) {
        return claims[_key(liquidationTx, logIndex)];
    }

    /// @dev The vault pays each event once, so a claim is never overwritten.
    function openClaim(bytes32 liquidationTx, uint32 logIndex, address liquidator, address builder, uint256 expected)
        external
    {
        if (msg.sender != vault) revert OnlyVault();
        claims[_key(liquidationTx, logIndex)] =
            Claim({liquidator: liquidator, builder: builder, expected: expected, recovered: 0});
        totalExpected += expected;
        emit ClaimOpened(liquidationTx, logIndex, liquidator, builder, expected);
    }

    /// @notice Pays toward a claim and re-credits the reserve. Anyone may call it, and an amount
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

        IERC20(asset).safeTransferFrom(msg.sender, address(this), accepted);
        IERC20(asset).forceApprove(vault, accepted);
        IVaultFund(vault).fund(accepted);

        emit RecoveryReceived(liquidationTx, logIndex, msg.sender, accepted);
        if (c.recovered == c.expected) emit ClaimSettled(liquidationTx, logIndex);
    }

    function _key(bytes32 liquidationTx, uint32 logIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(liquidationTx, logIndex));
    }
}
