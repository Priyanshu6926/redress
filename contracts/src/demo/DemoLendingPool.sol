// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A tiny isolated lending market for the live demo. It is not Aave. Each position has
/// its own oracle price, so one person's glitch cannot touch anyone else's position.
/// @dev A deposit opens a looped position with the ratio of the demo's Priya scenario: 300
/// collateral against 345.16 debt at 1.228849, a health factor near 1.02. The equity is the only
/// real money here, and a liquidator's profit is paid out of it, in real test ETH.
contract DemoLendingPool is ReentrancyGuard {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 public constant TRUE_PRICE = 1_228_849_000_000_000_000;
    uint256 public constant LT_BPS = 9_550;
    uint256 public constant BONUS_BPS = 100;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_SEVERITY_BPS = 600;
    uint256 public constant MAX_DEPOSIT = 0.02 ether;
    uint256 private constant UNIT_COLLATERAL = 300 ether;
    uint256 private constant UNIT_DEBT = 345.16 ether;
    uint256 private constant UNIT_EQUITY = (UNIT_COLLATERAL * TRUE_PRICE) / WAD - UNIT_DEBT;

    struct Position {
        address owner;
        uint256 collateral;
        uint256 debt;
        uint256 oraclePrice;
        bool closed;
    }

    error BadDeposit();
    error NotOwner();
    error BadSeverity();
    error Healthy();
    error Closed();
    error EthTransferFailed();

    event PositionOpened(uint256 indexed id, address indexed owner, uint256 deposit, uint256 collateral, uint256 debt);
    event OraclePriceChanged(uint256 indexed id, uint256 oldPrice, uint256 newPrice);
    /// Aave's event signature, so the same trigger and decoder apply.
    event LiquidationCall(
        address indexed collateralAsset,
        address indexed debtAsset,
        address indexed user,
        uint256 debtToCover,
        uint256 liquidatedCollateralAmount,
        address liquidator,
        bool receiveAToken
    );
    event PositionClosed(uint256 indexed id, address indexed owner, uint256 returned);

    address public immutable keeper;
    address public immutable collateralAsset;
    address public immutable debtAsset;
    uint256 public nextId = 1;
    mapping(uint256 id => Position position) public positions;

    constructor(address keeper_, address collateralAsset_, address debtAsset_) {
        keeper = keeper_;
        collateralAsset = collateralAsset_;
        debtAsset = debtAsset_;
    }

    function healthFactor(uint256 id) public view returns (uint256) {
        Position storage p = positions[id];
        if (p.debt == 0) return type(uint256).max;
        return (((p.collateral * p.oraclePrice) / WAD) * LT_BPS / BPS) * WAD / p.debt;
    }

    /// @notice What the position is worth at the true price, whatever the oracle says.
    function equity(uint256 id) public view returns (uint256) {
        Position storage p = positions[id];
        uint256 value = (p.collateral * TRUE_PRICE) / WAD;
        return value > p.debt ? value - p.debt : 0;
    }

    function open() external payable returns (uint256 id) {
        if (msg.value == 0 || msg.value > MAX_DEPOSIT) revert BadDeposit();
        id = nextId++;
        uint256 collateral = (msg.value * UNIT_COLLATERAL) / UNIT_EQUITY;
        uint256 debt = (msg.value * UNIT_DEBT) / UNIT_EQUITY;
        positions[id] = Position(msg.sender, collateral, debt, TRUE_PRICE, false);
        emit PositionOpened(id, msg.sender, msg.value, collateral, debt);
    }

    /// @notice Breaks this position's oracle. Only its owner can, so it is always opt-in.
    function glitch(uint256 id, uint256 severityBps) external {
        Position storage p = positions[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (p.closed) revert Closed();
        if (severityBps > MAX_SEVERITY_BPS) revert BadSeverity();
        uint256 price = (TRUE_PRICE * (BPS - severityBps)) / BPS;
        emit OraclePriceChanged(id, p.oraclePrice, price);
        p.oraclePrice = price;
    }

    /// @notice Anyone may trigger it, and the profit always goes to the keeper.
    function liquidate(uint256 id) external nonReentrant {
        Position storage p = positions[id];
        if (p.closed) revert Closed();
        if (healthFactor(id) >= WAD) revert Healthy();

        uint256 debtToCover = (p.debt * CLOSE_FACTOR_BPS) / BPS;
        uint256 seized = (debtToCover * WAD * (BPS + BONUS_BPS)) / (p.oraclePrice * BPS);
        uint256 before = equity(id);
        p.collateral -= seized;
        p.debt -= debtToCover;
        uint256 profit = before - equity(id);

        emit LiquidationCall(collateralAsset, debtAsset, p.owner, debtToCover, seized, keeper, false);
        (bool ok,) = keeper.call{value: profit}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice Returns what is left at the true price. Liquidation losses stay lost here.
    function close(uint256 id) external nonReentrant {
        Position storage p = positions[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (p.closed) revert Closed();
        uint256 returned = equity(id);
        p.closed = true;
        p.collateral = 0;
        p.debt = 0;
        emit PositionClosed(id, msg.sender, returned);
        (bool ok,) = msg.sender.call{value: returned}("");
        if (!ok) revert EthTransferFailed();
    }
}
