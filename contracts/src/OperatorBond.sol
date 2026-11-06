// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RedressVault} from "./RedressVault.sol";

/// @notice Oracle operators bond the payout asset against an adapter. When a paid redress is
/// attributed to that adapter, anyone can slash the bond and the slash refills the vault.
/// @dev The vault pays from its reserve and stays unaware of this contract, so the bond
/// reimburses the reserve after a payout rather than paying the victim first.
///
/// Trust: the attestor decides which adapter caused an event. The vault's report does not carry
/// the adapter, so attribution is a trusted, write-once input. It cannot raise a slash above the
/// redress the vault actually paid for that event.
contract OperatorBond is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Position {
        uint256 amount;
        uint256 pending; // requested for withdrawal; still slashable
        uint256 availableAt;
    }

    error InvalidConfig();
    error OnlyAttestor();
    error NotPaid();
    error AlreadyAttributed();
    error NotAttributed();
    error ZeroAmount();
    error NothingToSlash();
    error ExceedsBond();
    error WithdrawalNotReady();

    event BondDeposited(address indexed adapter, address indexed operator, uint256 amount);
    event WithdrawalRequested(address indexed adapter, address indexed operator, uint256 amount, uint256 availableAt);
    event BondWithdrawn(address indexed adapter, address indexed operator, uint256 amount);
    event Attributed(bytes32 indexed liquidationTx, uint32 logIndex, address indexed adapter);
    event BondSlashed(
        bytes32 indexed liquidationTx, uint32 logIndex, address indexed adapter, address operator, uint256 amount
    );

    RedressVault public immutable vault;
    IERC20 public immutable asset;
    address public immutable attestor;
    uint256 public immutable withdrawalDelay;

    uint256 public totalBonded;
    uint256 public totalSlashed;

    mapping(address adapter => mapping(address operator => Position position)) private positions;
    mapping(bytes32 key => address adapter) public attributedTo;
    mapping(bytes32 key => uint256 amount) public slashedFor;

    constructor(RedressVault vault_, address attestor_, uint256 withdrawalDelay_) {
        if (address(vault_) == address(0) || attestor_ == address(0) || withdrawalDelay_ == 0) revert InvalidConfig();
        vault = vault_;
        asset = vault_.payoutAsset();
        attestor = attestor_;
        withdrawalDelay = withdrawalDelay_;
    }

    function positionOf(address adapter, address operator) external view returns (Position memory) {
        return positions[adapter][operator];
    }

    function deposit(address adapter, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        positions[adapter][msg.sender].amount += amount;
        totalBonded += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit BondDeposited(adapter, msg.sender, amount);
    }

    /// @notice Starts the delay. A new request replaces the old one and restarts the delay.
    function requestWithdrawal(address adapter, uint256 amount) external {
        Position storage p = positions[adapter][msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > p.amount) revert ExceedsBond();
        p.pending = amount;
        p.availableAt = block.timestamp + withdrawalDelay;
        emit WithdrawalRequested(adapter, msg.sender, amount, p.availableAt);
    }

    /// @notice Pays the request, reduced by anything slashed during the delay.
    function withdraw(address adapter) external nonReentrant {
        Position storage p = positions[adapter][msg.sender];
        if (p.pending == 0 || block.timestamp < p.availableAt) revert WithdrawalNotReady();
        uint256 amount = p.pending < p.amount ? p.pending : p.amount;
        p.pending = 0;
        p.availableAt = 0;
        p.amount -= amount;
        totalBonded -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(adapter, msg.sender, amount);
    }

    /// @notice Names the adapter behind a paid redress. Write-once.
    function attribute(bytes32 liquidationTx, uint32 logIndex, address adapter) external {
        if (msg.sender != attestor) revert OnlyAttestor();
        if (!vault.recordOf(liquidationTx, logIndex).paid) revert NotPaid();
        bytes32 key = _key(liquidationTx, logIndex);
        if (attributedTo[key] != address(0)) revert AlreadyAttributed();
        attributedTo[key] = adapter;
        emit Attributed(liquidationTx, logIndex, adapter);
    }

    /// @notice Moves up to the unreimbursed redress from one operator's bond into the vault.
    /// Anyone may call it. Operators on the same adapter are slashed one call at a time.
    function slash(bytes32 liquidationTx, uint32 logIndex, address operator) external nonReentrant returns (uint256) {
        bytes32 key = _key(liquidationTx, logIndex);
        address adapter = attributedTo[key];
        if (adapter == address(0)) revert NotAttributed();

        uint256 remaining = vault.recordOf(liquidationTx, logIndex).redress - slashedFor[key];
        Position storage p = positions[adapter][operator];
        uint256 amount = remaining < p.amount ? remaining : p.amount;
        if (amount == 0) revert NothingToSlash();

        p.amount -= amount;
        slashedFor[key] += amount;
        totalBonded -= amount;
        totalSlashed += amount;

        asset.forceApprove(address(vault), amount);
        vault.fund(amount);
        emit BondSlashed(liquidationTx, logIndex, adapter, operator, amount);
        return amount;
    }

    function _key(bytes32 liquidationTx, uint32 logIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(liquidationTx, logIndex));
    }
}
