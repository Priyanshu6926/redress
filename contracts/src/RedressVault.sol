// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOperatorBond, IRecoveryLedger} from "./interfaces/IAccountability.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {VerdictMath} from "./VerdictMath.sol";

struct Verdict {
    bytes32 liquidationTx; // tx hash of the LiquidationCall
    uint32 logIndex;
    uint64 blockNumber;
    address user; // recipient
    address collateralAsset;
    address debtAsset;
    uint256 debtToCover; // X
    uint256 collateralSeized; // C, gross of the protocol fee
    uint256 bandLowE18; // p_c^L (numeraire per collateral unit)
    uint256 bandHighE18; // p_c^H
    uint256 debtPriceHighE18; // p_d^H
    uint256 liquidationBonusBps; // effective bonus for this position, 100 = 1%
    uint8 verdict; // 0 VALID, 1 WRONGFUL, 2 EXCESS, 3 AMBIGUOUS, 4 INCONCLUSIVE, 5 OVERPRICED
    uint8 sourceCount;
    uint256 redress; // computed off-chain, re-derived here
    bytes32 evidenceHash; // keccak256 of the evidence bundle
    address oracleAdapter; // AaveOracle.getSourceOfAsset(collateral) at the incident block
    address liquidator; // from the LiquidationCall event
    address builder; // the incident block's coinbase
}

interface IRedressVault is IReceiver {
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
    event Queued(bytes32 indexed liquidationTx, uint32 logIndex, address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event PauseChanged(bool paused);

    function fund(uint256 amount) external;
    function settle(bytes32 liquidationTx, uint32 logIndex) external;
}

/// @notice Records verdicts delivered by the CRE forwarder and pays the provable floor.
/// @dev Follows the CRE receiver pattern, but does not inherit ReceiverTemplate: its owner
/// setters for the forwarder and workflow identity would be admin powers. Here those values
/// are immutable and pause is the owner's only power.
///
/// Trust: the vault re-derives the arithmetic, not the facts. It cannot see mainnet, so it
/// trusts the report for the position, the band and the verdict.
contract RedressVault is IRedressVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant SOURCE_BOND = 0;
    uint8 private constant SOURCE_RESERVE = 1;
    uint256 private constant BPS = 10_000;

    struct Config {
        address forwarder;
        address payoutAsset;
        uint256 maxLiquidationBonusBps;
        uint256 epochCapBps;
        uint256 epochLength;
        /// Optional: leave zero for simulation, where MockKeystoneForwarder sends no metadata.
        bytes32 expectedWorkflowId;
        address expectedWorkflowOwner;
        /// Optional: zero pays from the reserve only and opens no claims.
        address bond;
        address ledger;
    }

    struct Record {
        bool attested;
        bool paid;
        uint8 verdict;
        address user;
        uint256 redress;
        bytes32 evidenceHash;
        address oracleAdapter;
        address liquidator;
        address builder;
    }

    error InvalidConfig();
    error InvalidSender(address sender, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidWorkflowOwner(address received, address expected);
    error MetadataTooShort(uint256 length);
    error AlreadyProcessed(bytes32 liquidationTx, uint32 logIndex);
    error BonusOutOfBounds(uint256 bonusBps);
    error RedressMismatch(uint256 reported, uint256 calculated);
    error RedressAboveCollateral(uint256 redress, uint256 cap);
    error InvalidRecipient();
    error NothingToSettle();
    error NotPayable();
    error IsPaused();
    error OnlyOwner();

    address public immutable owner;
    address public immutable forwarder;
    IERC20 public immutable payoutAsset;
    uint256 public immutable maxLiquidationBonusBps;
    uint256 public immutable epochCapBps;
    uint256 public immutable epochLength;
    bytes32 public immutable expectedWorkflowId;
    address public immutable expectedWorkflowOwner;
    IOperatorBond public immutable bond;
    IRecoveryLedger public immutable ledger;

    bool public paused;
    uint256 public totalFunded;
    uint256 public totalPaid; // from the reserve
    uint256 public totalPaidFromBond;
    uint256 public currentEpoch;
    uint256 public epochBudget;
    uint256 public epochSpent;

    mapping(bytes32 key => Record record) private records;

    constructor(Config memory cfg) {
        if (
            cfg.forwarder == address(0) || cfg.payoutAsset == address(0) || cfg.maxLiquidationBonusBps > BPS
                || cfg.epochCapBps == 0 || cfg.epochCapBps > BPS || cfg.epochLength == 0
        ) revert InvalidConfig();
        // Both are deployed first against this vault's predicted address, so there is no setter.
        if (cfg.bond != address(0)) {
            IOperatorBond b = IOperatorBond(cfg.bond);
            if (b.vault() != address(this) || b.asset() != cfg.payoutAsset) revert InvalidConfig();
        }
        if (cfg.ledger != address(0)) {
            IRecoveryLedger l = IRecoveryLedger(cfg.ledger);
            if (l.vault() != address(this) || l.asset() != cfg.payoutAsset) revert InvalidConfig();
        }

        owner = msg.sender;
        forwarder = cfg.forwarder;
        payoutAsset = IERC20(cfg.payoutAsset);
        maxLiquidationBonusBps = cfg.maxLiquidationBonusBps;
        epochCapBps = cfg.epochCapBps;
        epochLength = cfg.epochLength;
        expectedWorkflowId = cfg.expectedWorkflowId;
        expectedWorkflowOwner = cfg.expectedWorkflowOwner;
        bond = IOperatorBond(cfg.bond);
        ledger = IRecoveryLedger(cfg.ledger);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function available() public view returns (uint256) {
        return totalFunded - totalPaid;
    }

    function recordOf(bytes32 liquidationTx, uint32 logIndex) external view returns (Record memory) {
        return records[_key(liquidationTx, logIndex)];
    }

    function setPaused(bool value) external {
        if (msg.sender != owner) revert OnlyOwner();
        paused = value;
        emit PauseChanged(value);
    }

    /// @notice Adds to the reserve. Tokens sent directly are not counted.
    function fund(uint256 amount) external nonReentrant {
        _rollEpoch();
        totalFunded += amount;
        epochBudget += amount * epochCapBps / BPS;
        payoutAsset.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        _checkWorkflow(metadata);

        Verdict memory v = abi.decode(report, (Verdict));
        bytes32 key = _key(v.liquidationTx, v.logIndex);
        if (records[key].attested) revert AlreadyProcessed(v.liquidationTx, v.logIndex);
        if (v.liquidationBonusBps > maxLiquidationBonusBps) revert BonusOutOfBounds(v.liquidationBonusBps);

        uint256 calculated = VerdictMath.computeRedress(
            v.verdict, v.collateralSeized, v.debtToCover, v.bandLowE18, v.debtPriceHighE18, v.liquidationBonusBps
        );
        if (v.redress != calculated) revert RedressMismatch(v.redress, calculated);

        uint256 cap = v.collateralSeized * v.bandLowE18 / 1e18;
        if (v.redress > cap) revert RedressAboveCollateral(v.redress, cap);
        if (v.redress > 0 && v.user == address(0)) revert InvalidRecipient();

        records[key] = Record({
            attested: true,
            paid: false,
            verdict: v.verdict,
            user: v.user,
            redress: v.redress,
            evidenceHash: v.evidenceHash,
            oracleAdapter: v.oracleAdapter,
            liquidator: v.liquidator,
            builder: v.builder
        });
        emit Attested(v.liquidationTx, v.logIndex, v.user, v.verdict, v.redress, v.evidenceHash);

        if (v.redress == 0) return;
        if (_canPay(v.oracleAdapter, v.redress)) {
            _pay(key, v.liquidationTx, v.logIndex);
        } else {
            emit Queued(v.liquidationTx, v.logIndex, v.user, v.redress);
        }
    }

    /// @notice Pays a queued redress to its recorded user. Anyone may call it.
    function settle(bytes32 liquidationTx, uint32 logIndex) external nonReentrant {
        bytes32 key = _key(liquidationTx, logIndex);
        Record storage r = records[key];
        if (!r.attested || r.paid || r.redress == 0) revert NothingToSettle();
        if (paused) revert IsPaused();
        if (!_canPay(r.oracleAdapter, r.redress)) revert NotPayable();
        _pay(key, liquidationTx, logIndex);
    }

    /// Only the reserve's share counts against the reserve and the epoch cap. Payouts are whole:
    /// if the reserve cannot cover its share, nothing moves and the bond is left untouched.
    function _canPay(address adapter, uint256 amount) private returns (bool) {
        if (paused) return false;
        _rollEpoch();
        uint256 bonded = address(bond) == address(0) ? 0 : bond.available(adapter);
        uint256 fromReserve = amount > bonded ? amount - bonded : 0;
        return fromReserve <= available() && epochSpent + fromReserve <= epochBudget;
    }

    /// Bond first, then reserve, then a claim for what was paid.
    function _pay(bytes32 key, bytes32 liquidationTx, uint32 logIndex) private {
        Record storage r = records[key];
        r.paid = true;

        uint256 fromBond = address(bond) == address(0) ? 0 : bond.draw(r.oracleAdapter, r.redress, r.user);
        uint256 fromReserve = r.redress - fromBond;

        if (fromBond > 0) {
            totalPaidFromBond += fromBond;
            emit Paid(liquidationTx, r.user, address(payoutAsset), fromBond, SOURCE_BOND);
        }
        if (fromReserve > 0) {
            totalPaid += fromReserve;
            epochSpent += fromReserve;
            payoutAsset.safeTransfer(r.user, fromReserve);
            emit Paid(liquidationTx, r.user, address(payoutAsset), fromReserve, SOURCE_RESERVE);
        }
        if (address(ledger) != address(0)) {
            ledger.openClaim(liquidationTx, logIndex, r.liquidator, r.builder, r.redress);
        }
    }

    function _rollEpoch() private {
        uint256 epoch = block.timestamp / epochLength;
        if (epoch == currentEpoch) return;
        currentEpoch = epoch;
        epochSpent = 0;
        epochBudget = available() * epochCapBps / BPS;
    }

    function _checkWorkflow(bytes calldata metadata) private view {
        if (expectedWorkflowId == bytes32(0) && expectedWorkflowOwner == address(0)) return;
        // 62 bytes of identity; the production forwarder appends a 2-byte report id.
        if (metadata.length < 62) revert MetadataTooShort(metadata.length);

        bytes32 workflowId = bytes32(metadata[0:32]);
        address workflowOwner = address(bytes20(metadata[42:62]));
        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }
        if (expectedWorkflowOwner != address(0) && workflowOwner != expectedWorkflowOwner) {
            revert InvalidWorkflowOwner(workflowOwner, expectedWorkflowOwner);
        }
    }

    function _key(bytes32 liquidationTx, uint32 logIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(liquidationTx, logIndex));
    }
}
