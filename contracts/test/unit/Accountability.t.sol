// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {IRedressVault, RedressVault, Verdict} from "../../src/RedressVault.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {RecoveryLedger} from "../../src/RecoveryLedger.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";

contract AccountabilityTest is Test {
    address constant FORWARDER = address(0xF0);
    address constant OPERATOR = address(0x0E);
    address constant STRANGER = address(0x51);
    address constant ADAPTER = address(0xAD);
    address constant OTHER_ADAPTER = address(0xAE);
    address constant VICTIM = address(0xB0B);
    address constant LIQUIDATOR = address(0x11);
    address constant BUILDER = address(0xB1);
    uint256 constant DELAY = 7 days;
    uint256 constant WINDOW = 1 days;
    uint256 constant EPOCH = 1 days;
    uint256 constant RESERVE = 1_000 ether;
    uint8 constant WRONGFUL = 1;
    uint8 constant BOND_SOURCE = 0;
    uint8 constant RESERVE_SOURCE = 1;

    MockWETH weth;
    RedressVault vault;
    OperatorBond bond;
    RecoveryLedger ledger;

    function setUp() public {
        vm.warp(1_000 days);
        weth = new MockWETH();
        _deploy(10_000);
        _fund(RESERVE);

        weth.mint(OPERATOR, 1_000 ether);
        weth.mint(STRANGER, 1_000 ether);
        vm.prank(OPERATOR);
        weth.approve(address(bond), type(uint256).max);
        vm.prank(STRANGER);
        weth.approve(address(ledger), type(uint256).max);
    }

    function _deploy(uint256 capBps) private {
        uint64 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 2);
        bond = new OperatorBond(predicted, address(weth), address(this), DELAY, WINDOW);
        ledger = new RecoveryLedger(predicted, address(weth));
        vault = new RedressVault(_config(capBps, address(bond), address(ledger)));
        assertEq(address(vault), predicted);
    }

    function _config(uint256 capBps, address bond_, address ledger_) private view returns (RedressVault.Config memory) {
        return RedressVault.Config({
            forwarder: FORWARDER,
            payoutAsset: address(weth),
            maxLiquidationBonusBps: 2_000,
            epochCapBps: capBps,
            epochLength: EPOCH,
            expectedWorkflowId: bytes32(0),
            expectedWorkflowOwner: address(0),
            bond: bond_,
            ledger: ledger_
        });
    }

    function _fund(uint256 amount) private {
        weth.mint(address(this), amount);
        weth.approve(address(vault), amount);
        vault.fund(amount);
    }

    function _register(address adapter) private {
        if (bond.bondOf(adapter).operator == address(0)) bond.registerOperator(adapter, OPERATOR);
    }

    function _bond(uint256 amount) private {
        _register(ADAPTER);
        vm.prank(OPERATOR);
        bond.deposit(ADAPTER, amount);
    }

    /// A WRONGFUL report paying `collateral` * 1.2 less `debt`.
    function _verdict(bytes32 id, uint256 collateral, uint256 debt) private pure returns (Verdict memory v) {
        v.liquidationTx = id;
        v.logIndex = 7;
        v.blockNumber = 1;
        v.user = VICTIM;
        v.debtToCover = debt;
        v.collateralSeized = collateral;
        v.bandLowE18 = 1.2e18;
        v.bandHighE18 = 1.21e18;
        v.debtPriceHighE18 = 1e18;
        v.verdict = WRONGFUL;
        v.sourceCount = 3;
        v.redress = VerdictMath.computeRedress(WRONGFUL, collateral, debt, 1.2e18, 1e18, 0);
        v.evidenceHash = keccak256("evidence");
        v.oracleAdapter = ADAPTER;
        v.liquidator = LIQUIDATOR;
        v.builder = BUILDER;
    }

    function _send(Verdict memory v) private {
        vm.prank(FORWARDER);
        vault.onReport("", abi.encode(v));
    }

    /// Pays 10: C = 100, band low 1.2, X = 110.
    function _ten(bytes32 id) private pure returns (Verdict memory v) {
        v = _verdict(id, 100e18, 110e18);
        assert(v.redress == 10e18);
    }

    // Waterfall

    function test_waterfall_bondAloneCoversIt_reserveUntouched() public {
        _bond(50 ether);
        _send(_ten("a"));

        assertEq(weth.balanceOf(VICTIM), 10 ether);
        assertEq(bond.available(ADAPTER), 40 ether);
        assertEq(vault.available(), RESERVE);
        assertEq(vault.totalPaid(), 0);
        assertEq(vault.totalPaidFromBond(), 10 ether);
    }

    function test_waterfall_bondIsDrawnBeforeReserve_inThatOrder() public {
        _bond(4 ether);
        vm.recordLogs();
        _send(_ten("a"));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint8[] memory sources = new uint8[](2);
        uint256[] memory amounts = new uint256[](2);
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != IRedressVault.Paid.selector) continue;
            (, uint256 amount, uint8 source) = abi.decode(logs[i].data, (address, uint256, uint8));
            sources[found] = source;
            amounts[found] = amount;
            found++;
        }
        assertEq(found, 2);
        assertEq(sources[0], BOND_SOURCE);
        assertEq(amounts[0], 4 ether);
        assertEq(sources[1], RESERVE_SOURCE);
        assertEq(amounts[1], 6 ether);
    }

    function test_waterfall_bondExhaustion_reserveCoversTheRest() public {
        _bond(4 ether);
        _send(_ten("a"));

        assertEq(weth.balanceOf(VICTIM), 10 ether);
        assertEq(bond.available(ADAPTER), 0);
        assertEq(vault.available(), RESERVE - 6 ether);
        assertEq(vault.totalPaid(), 6 ether);
        assertEq(vault.totalPaidFromBond(), 4 ether);
    }

    function test_waterfall_afterExhaustionOnlyTheReservePays() public {
        _bond(4 ether);
        _send(_ten("a"));
        _send(_ten("b"));

        assertEq(weth.balanceOf(VICTIM), 20 ether);
        assertEq(vault.totalPaidFromBond(), 4 ether);
        assertEq(vault.totalPaid(), 16 ether);
    }

    function test_waterfall_anotherAdaptersBondIsNotUsed() public {
        _register(OTHER_ADAPTER);
        vm.prank(OPERATOR);
        bond.deposit(OTHER_ADAPTER, 50 ether);
        _send(_ten("a"));

        assertEq(bond.available(OTHER_ADAPTER), 50 ether);
        assertEq(vault.totalPaid(), 10 ether);
    }

    function test_waterfall_bondedShareDoesNotUseTheEpochCap() public {
        _deploy(100); // 1% of the reserve per epoch
        _fund(RESERVE); // budget is 10
        vm.prank(OPERATOR);
        weth.approve(address(bond), type(uint256).max);
        _bond(10 ether);

        _send(_ten("a"));
        assertEq(vault.epochSpent(), 0);
        _send(_ten("b"));
        assertEq(vault.epochSpent(), 10 ether);
        assertEq(weth.balanceOf(VICTIM), 20 ether);
    }

    function test_waterfall_queuedPayoutLeavesTheBondUntouched() public {
        _deploy(100);
        _fund(RESERVE); // budget 10
        vm.prank(OPERATOR);
        weth.approve(address(bond), type(uint256).max);
        _bond(1 ether);

        Verdict memory big = _verdict("big", 100e18, 100e18); // pays 20: 19 from reserve exceeds budget
        _send(big);

        assertFalse(vault.recordOf("big", 7).paid);
        assertEq(bond.available(ADAPTER), 1 ether);
        assertEq(weth.balanceOf(VICTIM), 0);
        assertEq(ledger.claimOf("big", 7).expected, 0, "no claim until paid");

        vm.warp(block.timestamp + EPOCH);
        vm.expectRevert(RedressVault.NotPayable.selector);
        vault.settle("big", 7); // the budget is still 10 in the new epoch

        _fund(1_000 ether); // adds 10 to the budget
        vault.settle("big", 7);
        assertEq(weth.balanceOf(VICTIM), 20 ether);
        assertEq(bond.available(ADAPTER), 0);
        assertEq(ledger.claimOf("big", 7).expected, 20 ether);
    }

    function test_waterfall_pausedPayoutQueuesAndDrawsNothing() public {
        _bond(50 ether);
        vault.setPaused(true);
        _send(_ten("a"));

        assertFalse(vault.recordOf("a", 7).paid);
        assertEq(bond.available(ADAPTER), 50 ether);
    }

    function test_waterfall_zeroRedressDrawsNothingAndOpensNoClaim() public {
        _bond(50 ether);
        Verdict memory v = _ten("a");
        v.verdict = 0;
        v.redress = 0;
        _send(v);

        assertEq(bond.available(ADAPTER), 50 ether);
        assertEq(ledger.totalExpected(), 0);
    }

    function test_waterfall_duplicateCannotDrawTwice() public {
        _bond(50 ether);
        _send(_ten("a"));
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RedressVault.AlreadyProcessed.selector, bytes32("a"), uint32(7)));
        vault.onReport("", abi.encode(_ten("a")));
        assertEq(bond.available(ADAPTER), 40 ether);
    }

    function test_waterfall_vaultWithoutBondPaysFromReserve() public {
        RedressVault plain = new RedressVault(_config(10_000, address(0), address(0)));
        weth.mint(address(this), 100 ether);
        weth.approve(address(plain), 100 ether);
        plain.fund(100 ether);

        vm.prank(FORWARDER);
        plain.onReport("", abi.encode(_ten("a")));
        assertEq(plain.totalPaid(), 10 ether);
    }

    function test_config_rejectsABondForAnotherVault() public {
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(_config(10_000, address(bond), address(0)));
    }

    function test_config_rejectsALedgerForAnotherVault() public {
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(_config(10_000, address(0), address(ledger)));
    }

    // OperatorBond

    function test_bond_onlyVaultDraws() public {
        _bond(10 ether);
        vm.prank(STRANGER);
        vm.expectRevert(OperatorBond.OnlyVault.selector);
        bond.draw(ADAPTER, 1 ether, STRANGER);
    }

    function test_bond_onlyTheRegisteredOperatorDeposits() public {
        _bond(1 ether);
        vm.prank(STRANGER);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.deposit(ADAPTER, 1 ether);
    }

    function test_bond_dustCannotSquatAnAdapter() public {
        vm.prank(STRANGER);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.deposit(ADAPTER, 1);
        assertEq(bond.bondOf(ADAPTER).operator, address(0));
        _bond(10 ether); // the real operator is unaffected
        assertEq(bond.available(ADAPTER), 10 ether);
    }

    function test_bond_onlyRegistrarRegisters() public {
        vm.prank(STRANGER);
        vm.expectRevert(OperatorBond.OnlyRegistrar.selector);
        bond.registerOperator(ADAPTER, STRANGER);
    }

    function test_bond_registrationIsWriteOnce() public {
        _register(ADAPTER);
        vm.expectRevert(OperatorBond.AlreadyRegistered.selector);
        bond.registerOperator(ADAPTER, STRANGER);
    }

    function test_bond_standingWithdrawalLapses() public {
        _bond(50 ether);
        vm.prank(OPERATOR);
        bond.requestWithdrawal(ADAPTER, 50 ether);

        // A request made long ago cannot be used as an exit when an incident happens.
        vm.warp(block.timestamp + DELAY + WINDOW);
        vm.prank(OPERATOR);
        vm.expectRevert(OperatorBond.WithdrawalExpired.selector);
        bond.withdraw(ADAPTER);

        _send(_ten("a"));
        assertEq(weth.balanceOf(VICTIM), 10 ether);
        assertEq(bond.available(ADAPTER), 40 ether);
    }

    function test_bond_withdrawalWorksUntilTheWindowCloses() public {
        _bond(50 ether);
        vm.prank(OPERATOR);
        bond.requestWithdrawal(ADAPTER, 50 ether);
        vm.warp(block.timestamp + DELAY + WINDOW - 1);
        vm.prank(OPERATOR);
        bond.withdraw(ADAPTER);
        assertEq(bond.available(ADAPTER), 0);
    }

    function test_bond_onlyOperatorWithdraws() public {
        _bond(10 ether);
        vm.prank(STRANGER);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.requestWithdrawal(ADAPTER, 1 ether);
    }

    function test_bond_withdrawalWaitsForDelay() public {
        _bond(100 ether);
        vm.startPrank(OPERATOR);
        bond.requestWithdrawal(ADAPTER, 40 ether);
        vm.expectRevert(OperatorBond.WithdrawalNotReady.selector);
        bond.withdraw(ADAPTER);

        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(OperatorBond.WithdrawalNotReady.selector);
        bond.withdraw(ADAPTER);

        vm.warp(block.timestamp + 1);
        uint256 before = weth.balanceOf(OPERATOR);
        bond.withdraw(ADAPTER);
        vm.stopPrank();
        assertEq(weth.balanceOf(OPERATOR), before + 40 ether);
        assertEq(bond.available(ADAPTER), 60 ether);
    }

    function test_bond_withdrawingDoesNotEscapeADraw() public {
        _bond(15 ether);
        vm.prank(OPERATOR);
        bond.requestWithdrawal(ADAPTER, 15 ether);

        _send(_ten("a"));

        vm.warp(block.timestamp + DELAY);
        uint256 before = weth.balanceOf(OPERATOR);
        vm.prank(OPERATOR);
        bond.withdraw(ADAPTER);
        assertEq(weth.balanceOf(OPERATOR), before + 5 ether);
        assertEq(bond.available(ADAPTER), 0);
    }

    function test_bond_cannotRequestMoreThanHeld() public {
        _bond(1 ether);
        vm.prank(OPERATOR);
        vm.expectRevert(OperatorBond.ExceedsBond.selector);
        bond.requestWithdrawal(ADAPTER, 2 ether);
    }

    // RecoveryLedger

    function test_ledger_eachPayoutOpensAClaim() public {
        _send(_ten("a"));
        RecoveryLedger.Claim memory c = ledger.claimOf("a", 7);
        assertEq(c.liquidator, LIQUIDATOR);
        assertEq(c.builder, BUILDER);
        assertEq(c.expected, 10 ether);
        assertEq(c.recovered, 0);
        assertEq(ledger.totalExpected(), 10 ether);
    }

    function test_ledger_claimCoversBondAndReserveShares() public {
        _bond(4 ether);
        _send(_ten("a"));
        assertEq(ledger.claimOf("a", 7).expected, 10 ether);
    }

    function test_ledger_recoveryRecreditsTheReserve() public {
        _send(_ten("a"));
        uint256 before = vault.available();
        vm.prank(STRANGER);
        ledger.receiveRecovery("a", 7, 3 ether);

        assertEq(vault.available(), before + 3 ether);
        assertEq(ledger.claimOf("a", 7).recovered, 3 ether);
        assertEq(ledger.totalRecovered(), 3 ether);
        assertEq(weth.balanceOf(address(ledger)), 0);
    }

    function test_ledger_overpaymentIsReducedToOutstanding() public {
        _send(_ten("a"));
        uint256 before = weth.balanceOf(STRANGER);
        vm.prank(STRANGER);
        uint256 accepted = ledger.receiveRecovery("a", 7, 500 ether);

        assertEq(accepted, 10 ether);
        assertEq(weth.balanceOf(STRANGER), before - 10 ether);
    }

    function test_ledger_settledClaimRejectsMore() public {
        _send(_ten("a"));
        vm.startPrank(STRANGER);
        ledger.receiveRecovery("a", 7, 10 ether);
        vm.expectRevert(RecoveryLedger.AlreadySettled.selector);
        ledger.receiveRecovery("a", 7, 1);
        vm.stopPrank();
    }

    function test_ledger_onlyVaultOpens() public {
        vm.prank(STRANGER);
        vm.expectRevert(RecoveryLedger.OnlyVault.selector);
        ledger.openClaim("a", 7, LIQUIDATOR, BUILDER, 1 ether);
    }

    function test_ledger_recoveryNeedsAClaim() public {
        vm.prank(STRANGER);
        vm.expectRevert(RecoveryLedger.NoClaim.selector);
        ledger.receiveRecovery("a", 7, 1 ether);
    }

    function test_ledger_missingLiquidatorStillPaysTheVictim() public {
        Verdict memory v = _ten("a");
        v.liquidator = address(0);
        v.builder = address(0);
        _send(v);
        assertEq(weth.balanceOf(VICTIM), 10 ether);
    }

    function testFuzz_ledger_recoveredNeverExceedsExpected(uint96 first, uint96 second) public {
        _send(_ten("a"));
        first = uint96(bound(first, 1, 500 ether));
        second = uint96(bound(second, 1, 500 ether));
        vm.startPrank(STRANGER);
        ledger.receiveRecovery("a", 7, first);
        if (first < 10 ether) ledger.receiveRecovery("a", 7, second);
        vm.stopPrank();
        assertLe(ledger.claimOf("a", 7).recovered, 10 ether);
    }
}
