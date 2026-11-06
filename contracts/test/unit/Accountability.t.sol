// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RedressVault, Verdict} from "../../src/RedressVault.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {RecoveryLedger} from "../../src/RecoveryLedger.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";

contract AccountabilityTest is Test {
    address constant FORWARDER = address(0xF0);
    address constant ATTESTOR = address(0xA7);
    address constant OPERATOR = address(0x0E);
    address constant OTHER_OPERATOR = address(0x0F);
    address constant STRANGER = address(0x51);
    address constant ADAPTER = address(0xAD);
    address constant USER = address(0xB0B);
    address constant LIQUIDATOR = address(0x11);
    address constant BUILDER = address(0xB1);
    bytes32 constant TX = keccak256("liquidation");
    uint32 constant LOG = 17;
    uint256 constant DELAY = 7 days;

    MockWETH weth;
    RedressVault vault;
    OperatorBond bond;
    RecoveryLedger ledger;
    uint256 redress;

    function setUp() public {
        weth = new MockWETH();
        vault = new RedressVault(
            RedressVault.Config({
                forwarder: FORWARDER,
                payoutAsset: address(weth),
                maxLiquidationBonusBps: 2_000,
                epochCapBps: 10_000,
                epochLength: 1 days,
                expectedWorkflowId: bytes32(0),
                expectedWorkflowOwner: address(0)
            })
        );
        bond = new OperatorBond(vault, ATTESTOR, DELAY);
        ledger = new RecoveryLedger(vault, ATTESTOR);

        weth.mint(address(this), 1_000 ether);
        weth.approve(address(vault), type(uint256).max);
        vault.fund(1_000 ether);
        redress = _payEvent(TX, LOG);

        for (uint160 i = 0; i < 3; i++) {
            address who = [OPERATOR, OTHER_OPERATOR, STRANGER][i];
            weth.mint(who, 1_000 ether);
            vm.startPrank(who);
            weth.approve(address(bond), type(uint256).max);
            weth.approve(address(ledger), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// One WRONGFUL report: 10 collateral at 1.2 and 1 debt at a 1% bonus.
    function _report(bytes32 tx_, uint32 logIndex) private pure returns (Verdict memory v) {
        v = Verdict({
            liquidationTx: tx_,
            logIndex: logIndex,
            blockNumber: 1,
            user: USER,
            collateralAsset: address(1),
            debtAsset: address(2),
            debtToCover: 1 ether,
            collateralSeized: 10 ether,
            bandLowE18: 1.2 ether,
            bandHighE18: 1.21 ether,
            debtPriceHighE18: 1 ether,
            liquidationBonusBps: 100,
            verdict: 1,
            sourceCount: 3,
            redress: 0,
            evidenceHash: keccak256("evidence")
        });
    }

    function _payEvent(bytes32 tx_, uint32 logIndex) private returns (uint256) {
        Verdict memory v = _report(tx_, logIndex);
        v.redress = VerdictMath.computeRedress(
            v.verdict, v.collateralSeized, v.debtToCover, v.bandLowE18, v.debtPriceHighE18, v.liquidationBonusBps
        );
        assertGt(v.redress, 0, "fixture must have a redress");
        vm.prank(FORWARDER);
        vault.onReport("", abi.encode(v));
        assertTrue(vault.recordOf(tx_, logIndex).paid, "fixture event must pay");
        return v.redress;
    }

    function _deposit(address operator, uint256 amount) private {
        vm.prank(operator);
        bond.deposit(ADAPTER, amount);
    }

    function _attribute() private {
        vm.prank(ATTESTOR);
        bond.attribute(TX, LOG, ADAPTER);
    }

    function _open() private {
        vm.prank(ATTESTOR);
        ledger.openClaim(TX, LOG, LIQUIDATOR, BUILDER);
    }

    // OperatorBond

    function test_bond_slashRefillsVaultByRedress() public {
        _deposit(OPERATOR, 100 ether);
        _attribute();
        uint256 before = vault.available();

        vm.prank(STRANGER);
        uint256 slashed = bond.slash(TX, LOG, OPERATOR);

        assertEq(slashed, redress);
        assertEq(vault.available(), before + redress);
        assertEq(bond.positionOf(ADAPTER, OPERATOR).amount, 100 ether - redress);
        assertEq(bond.totalSlashed(), redress);
    }

    function test_bond_cannotSlashTwiceForOneEvent() public {
        _deposit(OPERATOR, 100 ether);
        _attribute();
        bond.slash(TX, LOG, OPERATOR);
        vm.expectRevert(OperatorBond.NothingToSlash.selector);
        bond.slash(TX, LOG, OPERATOR);
    }

    function test_bond_smallBondSlashesWhatItHolds_thenNextOperatorCoversTheRest() public {
        _deposit(OPERATOR, 1 ether);
        _deposit(OTHER_OPERATOR, 100 ether);
        _attribute();

        assertEq(bond.slash(TX, LOG, OPERATOR), 1 ether);
        assertEq(bond.slash(TX, LOG, OTHER_OPERATOR), redress - 1 ether);
        assertEq(bond.slashedFor(keccak256(abi.encode(TX, LOG))), redress);
    }

    function test_bond_otherAdapterIsNotSlashed() public {
        vm.prank(OPERATOR);
        bond.deposit(address(0xDEAD), 100 ether);
        _attribute();
        vm.expectRevert(OperatorBond.NothingToSlash.selector);
        bond.slash(TX, LOG, OPERATOR);
    }

    function test_bond_slashNeedsAttribution() public {
        _deposit(OPERATOR, 100 ether);
        vm.expectRevert(OperatorBond.NotAttributed.selector);
        bond.slash(TX, LOG, OPERATOR);
    }

    function test_bond_onlyAttestorAttributes() public {
        vm.prank(STRANGER);
        vm.expectRevert(OperatorBond.OnlyAttestor.selector);
        bond.attribute(TX, LOG, ADAPTER);
    }

    function test_bond_attributionIsWriteOnce() public {
        _attribute();
        vm.prank(ATTESTOR);
        vm.expectRevert(OperatorBond.AlreadyAttributed.selector);
        bond.attribute(TX, LOG, address(0xBEEF));
    }

    function test_bond_cannotAttributeUnpaidEvent() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(OperatorBond.NotPaid.selector);
        bond.attribute(keccak256("never reported"), 0, ADAPTER);
    }

    function test_bond_withdrawalWaitsForDelay() public {
        _deposit(OPERATOR, 100 ether);
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
        assertEq(bond.positionOf(ADAPTER, OPERATOR).amount, 60 ether);
    }

    function test_bond_withdrawingDoesNotEscapeASlash() public {
        _deposit(OPERATOR, 20 ether);
        vm.prank(OPERATOR);
        bond.requestWithdrawal(ADAPTER, 20 ether);

        _attribute();
        bond.slash(TX, LOG, OPERATOR);

        vm.warp(block.timestamp + DELAY);
        uint256 before = weth.balanceOf(OPERATOR);
        vm.prank(OPERATOR);
        bond.withdraw(ADAPTER);
        assertEq(weth.balanceOf(OPERATOR), before + 20 ether - redress);
        assertEq(bond.positionOf(ADAPTER, OPERATOR).amount, 0);
    }

    function test_bond_cannotRequestMoreThanHeld() public {
        _deposit(OPERATOR, 1 ether);
        vm.prank(OPERATOR);
        vm.expectRevert(OperatorBond.ExceedsBond.selector);
        bond.requestWithdrawal(ADAPTER, 2 ether);
    }

    function test_bond_totalsMatchTokensHeld() public {
        _deposit(OPERATOR, 100 ether);
        _attribute();
        bond.slash(TX, LOG, OPERATOR);
        assertEq(weth.balanceOf(address(bond)), bond.totalBonded());
    }

    // RecoveryLedger

    function test_ledger_expectedComesFromTheVault() public {
        _open();
        RecoveryLedger.Claim memory c = ledger.claimOf(TX, LOG);
        assertEq(c.expected, redress);
        assertEq(c.liquidator, LIQUIDATOR);
        assertEq(c.builder, BUILDER);
        assertEq(ledger.totalExpected(), redress);
    }

    function test_ledger_recoveryRecreditsVault() public {
        _open();
        uint256 before = vault.available();
        vm.prank(STRANGER);
        ledger.receiveRecovery(TX, LOG, 3 ether);

        assertEq(vault.available(), before + 3 ether);
        assertEq(ledger.claimOf(TX, LOG).recovered, 3 ether);
        assertEq(weth.balanceOf(address(ledger)), 0);
    }

    function test_ledger_overpaymentIsReducedToOutstanding() public {
        _open();
        uint256 before = weth.balanceOf(STRANGER);
        vm.prank(STRANGER);
        uint256 accepted = ledger.receiveRecovery(TX, LOG, 500 ether);

        assertEq(accepted, redress);
        assertEq(weth.balanceOf(STRANGER), before - redress);
    }

    function test_ledger_settledClaimRejectsMore() public {
        _open();
        vm.startPrank(STRANGER);
        ledger.receiveRecovery(TX, LOG, redress);
        vm.expectRevert(RecoveryLedger.AlreadySettled.selector);
        ledger.receiveRecovery(TX, LOG, 1);
        vm.stopPrank();
    }

    function test_ledger_onlyAttestorOpens() public {
        vm.prank(STRANGER);
        vm.expectRevert(RecoveryLedger.OnlyAttestor.selector);
        ledger.openClaim(TX, LOG, LIQUIDATOR, BUILDER);
    }

    function test_ledger_claimIsWriteOnce() public {
        _open();
        vm.prank(ATTESTOR);
        vm.expectRevert(RecoveryLedger.ClaimExists.selector);
        ledger.openClaim(TX, LOG, STRANGER, BUILDER);
    }

    function test_ledger_cannotOpenForUnpaidEvent() public {
        vm.prank(ATTESTOR);
        vm.expectRevert(RecoveryLedger.NotPaid.selector);
        ledger.openClaim(keccak256("never reported"), 0, LIQUIDATOR, BUILDER);
    }

    function test_ledger_recoveryNeedsAClaim() public {
        vm.prank(STRANGER);
        vm.expectRevert(RecoveryLedger.NoClaim.selector);
        ledger.receiveRecovery(TX, LOG, 1 ether);
    }

    function testFuzz_ledger_recoveredNeverExceedsExpected(uint96 first, uint96 second) public {
        _open();
        first = uint96(bound(first, 1, 500 ether));
        second = uint96(bound(second, 1, 500 ether));
        vm.startPrank(STRANGER);
        ledger.receiveRecovery(TX, LOG, first);
        if (first < redress) ledger.receiveRecovery(TX, LOG, second);
        vm.stopPrank();
        assertLe(ledger.claimOf(TX, LOG).recovered, redress);
    }
}
