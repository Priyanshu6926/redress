// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOperatorBond} from "./interfaces/IAccountability.sol";

/// @notice An oracle operator bonds the payout asset against an adapter. When a verdict names
/// that adapter, the vault pays the victim from this bond before touching its reserve.
/// @dev One operator per adapter, named once by the registrar, so nobody can squat an adapter
/// with a dust deposit. The adapter comes from the report, which the workflow reads from
/// AaveOracle.getSourceOfAsset at the incident block, so a bond is only as trustworthy as the
/// report path. Through the mock forwarder a forged report can draw it.
///
/// A withdrawal is only open for a short window after its delay. Without that, an operator could
/// request once and hold a standing exit to use the moment an incident happens. An operator who
/// keeps re-requesting still has a window once per cycle, so a pending request is public through
/// `bondOf` and should be read as reduced cover.
contract OperatorBond is IOperatorBond, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Bond {
        address operator;
        uint256 amount;
        uint256 pending; // requested for withdrawal; still drawable
        uint256 availableAt;
    }

    error InvalidConfig();
    error OnlyVault();
    error OnlyRegistrar();
    error AlreadyRegistered();
    error NotOperator();
    error ZeroAmount();
    error ExceedsBond();
    error WithdrawalNotReady();
    error WithdrawalExpired();

    event OperatorRegistered(address indexed adapter, address indexed operator);
    event BondDeposited(address indexed adapter, address indexed operator, uint256 amount);
    event WithdrawalRequested(address indexed adapter, uint256 amount, uint256 availableAt);
    event BondWithdrawn(address indexed adapter, address indexed operator, uint256 amount);
    event BondDrawn(address indexed adapter, address indexed recipient, uint256 amount);

    address public immutable vault;
    address public immutable asset;
    address public immutable registrar;
    uint256 public immutable withdrawalDelay;
    uint256 public immutable withdrawalWindow;

    uint256 public totalBonded;
    uint256 public totalDrawn;

    mapping(address adapter => Bond bond) private bonds;

    constructor(
        address vault_,
        address asset_,
        address registrar_,
        uint256 withdrawalDelay_,
        uint256 withdrawalWindow_
    ) {
        if (
            vault_ == address(0) || asset_ == address(0) || registrar_ == address(0) || withdrawalDelay_ == 0
                || withdrawalWindow_ == 0
        ) revert InvalidConfig();
        vault = vault_;
        asset = asset_;
        registrar = registrar_;
        withdrawalDelay = withdrawalDelay_;
        withdrawalWindow = withdrawalWindow_;
    }

    /// @notice Names an adapter's operator. Write-once, and the registrar's only power.
    function registerOperator(address adapter, address operator) external {
        if (msg.sender != registrar) revert OnlyRegistrar();
        if (operator == address(0)) revert InvalidConfig();
        if (bonds[adapter].operator != address(0)) revert AlreadyRegistered();
        bonds[adapter].operator = operator;
        emit OperatorRegistered(adapter, operator);
    }

    function bondOf(address adapter) external view returns (Bond memory) {
        return bonds[adapter];
    }

    function available(address adapter) external view returns (uint256) {
        return bonds[adapter].amount;
    }

    function deposit(address adapter, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Bond storage b = bonds[adapter];
        if (msg.sender != b.operator) revert NotOperator();
        b.amount += amount;
        totalBonded += amount;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit BondDeposited(adapter, msg.sender, amount);
    }

    /// @notice Starts the delay. A new request replaces the old one and restarts it.
    function requestWithdrawal(address adapter, uint256 amount) external {
        Bond storage b = bonds[adapter];
        if (msg.sender != b.operator) revert NotOperator();
        if (amount == 0) revert ZeroAmount();
        if (amount > b.amount) revert ExceedsBond();
        b.pending = amount;
        b.availableAt = block.timestamp + withdrawalDelay;
        emit WithdrawalRequested(adapter, amount, b.availableAt);
    }

    /// @notice Pays the request, reduced by anything drawn during the delay. Lapses after the window.
    function withdraw(address adapter) external nonReentrant {
        Bond storage b = bonds[adapter];
        if (msg.sender != b.operator) revert NotOperator();
        if (b.pending == 0 || block.timestamp < b.availableAt) revert WithdrawalNotReady();
        if (block.timestamp >= b.availableAt + withdrawalWindow) revert WithdrawalExpired();
        uint256 amount = b.pending < b.amount ? b.pending : b.amount;
        b.pending = 0;
        b.availableAt = 0;
        b.amount -= amount;
        totalBonded -= amount;
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit BondWithdrawn(adapter, msg.sender, amount);
    }

    function draw(address adapter, uint256 amount, address recipient) external nonReentrant returns (uint256 paid) {
        if (msg.sender != vault) revert OnlyVault();
        Bond storage b = bonds[adapter];
        paid = amount < b.amount ? amount : b.amount;
        if (paid == 0) return 0;
        b.amount -= paid;
        totalBonded -= paid;
        totalDrawn += paid;
        IERC20(asset).safeTransfer(recipient, paid);
        emit BondDrawn(adapter, recipient, paid);
    }
}
