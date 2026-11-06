// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RedressVault, Verdict} from "../../src/RedressVault.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {RecoveryLedger} from "../../src/RecoveryLedger.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";

/// Drives the vault, bond and ledger together, keeping its own count of every token movement.
contract AccountabilityHandler is Test {
    address internal constant FORWARDER = address(0xF0);
    address internal constant ADAPTER = address(0xAD);
    address internal constant VICTIM = address(0xB0B);

    RedressVault public vault;
    OperatorBond public bond;
    RecoveryLedger public ledger;
    MockWETH public weth;

    uint256 public ghostFunded;
    uint256 public ghostRecovered;
    uint256 public ghostBonded;
    uint256 public ghostWithdrawn;
    uint256 private nonce;
    bytes32[] public paidEvents;
    bytes32[] public queuedEvents;

    constructor(RedressVault vault_, OperatorBond bond_, RecoveryLedger ledger_, MockWETH weth_) {
        vault = vault_;
        bond = bond_;
        ledger = ledger_;
        weth = weth_;
        weth.approve(address(vault), type(uint256).max);
        weth.approve(address(bond), type(uint256).max);
        weth.approve(address(ledger), type(uint256).max);
    }

    function report(uint256 c, uint256 x) external {
        Verdict memory v;
        v.liquidationTx = keccak256(abi.encode(nonce++));
        v.user = VICTIM;
        v.verdict = 1;
        v.collateralSeized = bound(c, 1e18, 100e18);
        v.debtToCover = bound(x, 0, 100e18);
        v.bandLowE18 = 1.2e18;
        v.bandHighE18 = 1.2e18;
        v.debtPriceHighE18 = 1e18;
        v.oracleAdapter = ADAPTER;
        v.liquidator = address(0x11);
        v.builder = address(0xB1);
        v.redress = VerdictMath.computeRedress(1, v.collateralSeized, v.debtToCover, 1.2e18, 1e18, 0);

        vm.prank(FORWARDER);
        vault.onReport("", abi.encode(v));
        if (v.redress == 0) return;
        if (vault.recordOf(v.liquidationTx, 0).paid) paidEvents.push(v.liquidationTx);
        else queuedEvents.push(v.liquidationTx);
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0, 500e18);
        weth.mint(address(this), amount);
        vault.fund(amount);
        ghostFunded += amount;
    }

    function depositBond(uint256 amount) external {
        amount = bound(amount, 1, 100e18);
        weth.mint(address(this), amount);
        bond.deposit(ADAPTER, amount);
        ghostBonded += amount;
    }

    function requestWithdrawal(uint256 amount) external {
        uint256 held = bond.available(ADAPTER);
        if (held == 0) return;
        bond.requestWithdrawal(ADAPTER, bound(amount, 1, held));
    }

    function withdraw() external {
        uint256 before = weth.balanceOf(address(this));
        try bond.withdraw(ADAPTER) {
            ghostWithdrawn += weth.balanceOf(address(this)) - before;
        } catch {}
    }

    function recover(uint256 index, uint256 amount) external {
        if (paidEvents.length == 0) return;
        amount = bound(amount, 1, 50e18);
        weth.mint(address(this), amount);
        uint256 before = weth.balanceOf(address(this));
        try ledger.receiveRecovery(paidEvents[index % paidEvents.length], 0, amount) returns (uint256 accepted) {
            ghostRecovered += accepted;
            ghostFunded += accepted;
            assertEq(before - weth.balanceOf(address(this)), accepted);
        } catch {}
    }

    function settle(uint256 index) external {
        if (queuedEvents.length == 0) return;
        bytes32 id = queuedEvents[index % queuedEvents.length];
        try vault.settle(id, 0) {
            paidEvents.push(id);
        } catch {}
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1, 8 days));
    }
}

contract AccountabilityInvariantTest is Test {
    address private constant VICTIM = address(0xB0B);

    RedressVault private vault;
    OperatorBond private bond;
    RecoveryLedger private ledger;
    MockWETH private weth;
    AccountabilityHandler private handler;

    function setUp() public {
        vm.warp(1_000 days);
        weth = new MockWETH();
        uint64 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 2);
        bond = new OperatorBond(predicted, address(weth), address(this), 7 days, 1 days);
        ledger = new RecoveryLedger(predicted, address(weth));
        vault = new RedressVault(
            RedressVault.Config({
                forwarder: address(0xF0),
                payoutAsset: address(weth),
                maxLiquidationBonusBps: 2_000,
                epochCapBps: 2_000,
                epochLength: 1 days,
                expectedWorkflowId: bytes32(0),
                expectedWorkflowOwner: address(0),
                bond: address(bond),
                ledger: address(ledger)
            })
        );
        handler = new AccountabilityHandler(vault, bond, ledger, weth);
        bond.registerOperator(address(0xAD), address(handler));
        targetContract(address(handler));
    }

    /// Recoveries reach the reserve through fund, so totalFunded is funded plus recovered.
    function invariant_totalPaidNeverExceedsFundedPlusRecovered() public view {
        assertLe(vault.totalPaid(), handler.ghostFunded());
        assertEq(vault.totalFunded(), handler.ghostFunded());
        assertLe(ledger.totalRecovered(), handler.ghostFunded());
    }

    function invariant_vaultHoldsExactlyItsReserve() public view {
        assertEq(weth.balanceOf(address(vault)), vault.available());
    }

    function invariant_bondHoldsExactlyWhatIsBonded() public view {
        assertEq(weth.balanceOf(address(bond)), bond.totalBonded());
        assertEq(bond.totalBonded() + bond.totalDrawn() + handler.ghostWithdrawn(), handler.ghostBonded());
    }

    function invariant_victimReceivedExactlyBothShares() public view {
        assertEq(weth.balanceOf(VICTIM), vault.totalPaid() + vault.totalPaidFromBond());
        assertEq(bond.totalDrawn(), vault.totalPaidFromBond());
    }

    function invariant_claimsCoverEveryPayout() public view {
        assertEq(ledger.totalExpected(), vault.totalPaid() + vault.totalPaidFromBond());
        assertLe(ledger.totalRecovered(), ledger.totalExpected());
        assertEq(ledger.totalRecovered(), handler.ghostRecovered());
    }

    function invariant_ledgerHoldsNothing() public view {
        assertEq(weth.balanceOf(address(ledger)), 0);
    }
}
