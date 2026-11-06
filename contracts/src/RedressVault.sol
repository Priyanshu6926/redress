// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./VerdictMath.sol";
import "./OperatorBond.sol";
import "./RecoveryLedger.sol";

struct Verdict {
    bytes32 liquidationTx;    // tx hash of the LiquidationCall
    uint32  logIndex;
    uint64  blockNumber;
    address user;             // recipient
    address collateralAsset;
    address debtAsset;
    uint256 debtToCover;      // X
    uint256 collateralSeized; // C, gross of the protocol fee
    uint256 bandLowE18;       // p_c^L (numeraire per collateral unit)
    uint256 bandHighE18;      // p_c^H
    uint256 debtPriceHighE18; // p_d^H
    uint256 liquidationBonusBps; // effective bonus for this position, 100 = 1%
    uint8   verdict;          // 0 VALID, 1 WRONGFUL, 2 EXCESS, 3 AMBIGUOUS, 4 INCONCLUSIVE, 5 OVERPRICED
    uint8   sourceCount;
    uint256 redress;          // computed off-chain, re-derived on-chain
    bytes32 evidenceHash;     // keccak256 of the Swarm bundle
}

interface IRedressVault {
    function onReport(bytes calldata metadata, bytes calldata report) external;
    function fund(uint256 amount) external;
    function receiveRecovery(bytes32 liquidationTx, uint256 amount) external;
    
    event Attested(
        bytes32 indexed liquidationTx,
        uint32 logIndex,
        address indexed user,
        uint8 verdict,
        uint256 redress,
        bytes32 evidenceHash
    );
    event Paid(
        bytes32 indexed liquidationTx,
        address indexed user,
        address asset,
        uint256 amount,
        uint8 source // 0: bond, 1: reserve, 2: treasury
    );
}

contract RedressVault is IRedressVault {
    using VerdictMath for uint8;

    /// Largest liquidation bonus a report may claim. Aave bonuses seen on Core and Prime
    /// are 1% to 6%, so 20% leaves headroom while bounding what a bad report can assert.
    uint256 public constant MAX_LIQUIDATION_BONUS_BPS = 2_000;

    error BonusOutOfBounds(uint256 bonusBps);
    error RedressMismatch(uint256 reported, uint256 calculated);

    address public immutable owner;
    address public forwarder; // Chainlink CRE forwarder
    OperatorBond public operatorBond;
    RecoveryLedger public recoveryLedger;

    uint256 public totalReserve;
    uint256 public totalPaid;
    uint256 public totalRecovered;

    // Idempotency: (liquidationTx, logIndex) => processed
    mapping(bytes32 => mapping(uint32 => bool)) public processed;

    modifier onlyForwarder() {
        require(msg.sender == forwarder || msg.sender == owner, "Unauthorized report sender");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _forwarder) {
        owner = msg.sender;
        forwarder = _forwarder;
    }

    function setDependencies(address _bond, address _ledger) external onlyOwner {
        operatorBond = OperatorBond(_bond);
        recoveryLedger = RecoveryLedger(_ledger);
    }

    function setForwarder(address _forwarder) external onlyOwner {
        forwarder = _forwarder;
    }

    function fund(uint256 amount) external override {
        // Mock reserve funding helper
        totalReserve += amount;
    }

    receive() external payable {
        totalReserve += msg.value;
    }

    function receiveRecovery(bytes32 liquidationTx, uint256 amount) external override {
        totalRecovered += amount;
        if (address(recoveryLedger) != address(0)) {
            recoveryLedger.recordRecovery(liquidationTx, amount);
        }
    }

    function onReport(bytes calldata /* metadata */, bytes calldata report) external override onlyForwarder {
        Verdict memory v = abi.decode(report, (Verdict));

        require(!processed[v.liquidationTx][v.logIndex], "Already processed");
        processed[v.liquidationTx][v.logIndex] = true;

        if (v.liquidationBonusBps > MAX_LIQUIDATION_BONUS_BPS) revert BonusOutOfBounds(v.liquidationBonusBps);

        // Re-derive the redress floor on-chain. It must equal the report exactly.
        uint256 calculatedRedress = VerdictMath.computeRedress(
            v.verdict,
            v.collateralSeized,
            v.debtToCover,
            v.bandLowE18,
            v.debtPriceHighE18,
            v.liquidationBonusBps
        );

        if (v.redress != calculatedRedress) revert RedressMismatch(v.redress, calculatedRedress);

        emit Attested(v.liquidationTx, v.logIndex, v.user, v.verdict, v.redress, v.evidenceHash);

        if (v.redress > 0) {
            _executePayout(v);
        }
    }

    function _executePayout(Verdict memory v) internal {
        require(totalPaid + v.redress <= totalReserve + totalRecovered, "Exceeds vault reserve");
        totalPaid += v.redress;

        // Payout to victim
        (bool sent, ) = payable(v.user).call{value: v.redress}("");
        require(sent, "Payout transfer failed");

        emit Paid(v.liquidationTx, v.user, v.debtAsset, v.redress, 1 /* reserve */);
    }
}

