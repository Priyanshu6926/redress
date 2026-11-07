// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DemoLendingPool} from "../../src/demo/DemoLendingPool.sol";
import {DemoWETH} from "../../src/demo/DemoWETH.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {RecoveryLedger} from "../../src/RecoveryLedger.sol";
import {RedressVault, Verdict} from "../../src/RedressVault.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";

contract LiveDemoTest is Test {
    address constant FORWARDER = address(0xF0);
    address constant KEEPER = address(0x4EE9);
    address constant USER = address(0xB0B);
    address constant ADAPTER = address(0xAD);
    uint256 constant DEPOSIT = 0.01 ether;

    DemoWETH weth;
    DemoLendingPool pool;
    RedressVault vault;
    OperatorBond bond;
    RecoveryLedger ledger;

    function setUp() public {
        weth = new DemoWETH();
        pool = new DemoLendingPool(KEEPER, address(1), address(weth));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        bond = new OperatorBond(predicted, address(weth), address(this), 7 days, 1 days);
        ledger = new RecoveryLedger(predicted, address(weth));
        vault = new RedressVault(
            RedressVault.Config({
                forwarder: FORWARDER,
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
        weth.setAutoUnwrap(address(vault));
        weth.setAutoUnwrap(address(bond));

        weth.deposit{value: 0.03 ether}();
        weth.approve(address(vault), type(uint256).max);
        vault.fund(0.015 ether);
        bond.registerOperator(ADAPTER, address(this));
        weth.approve(address(bond), type(uint256).max);
        bond.deposit(ADAPTER, 0.015 ether);

        vm.deal(USER, 1 ether);
    }

    function _open() private returns (uint256 id) {
        vm.prank(USER);
        id = pool.open{value: DEPOSIT}();
    }

    function test_openIsHealthyAndKeepsTheDepositAsEquity() public {
        uint256 id = _open();
        assertApproxEqRel(pool.healthFactor(id), 1.02e18, 0.001e18);
        assertApproxEqAbs(pool.equity(id), DEPOSIT, 10);
    }

    function test_closeWithoutAGlitchReturnsTheDeposit() public {
        uint256 id = _open();
        vm.prank(USER);
        pool.close(id);
        assertApproxEqAbs(USER.balance, 1 ether, 10);
    }

    function test_aHealthyPositionCannotBeLiquidated() public {
        uint256 id = _open();
        vm.expectRevert(DemoLendingPool.Healthy.selector);
        pool.liquidate(id);
    }

    function test_onlyTheOwnerGlitchesAndCloses() public {
        uint256 id = _open();
        vm.expectRevert(DemoLendingPool.NotOwner.selector);
        pool.glitch(id, 285);
        vm.expectRevert(DemoLendingPool.NotOwner.selector);
        pool.close(id);
    }

    function test_severityIsBounded() public {
        uint256 id = _open();
        vm.prank(USER);
        vm.expectRevert(DemoLendingPool.BadSeverity.selector);
        pool.glitch(id, 601);
    }

    function test_depositIsBounded() public {
        vm.prank(USER);
        vm.expectRevert(DemoLendingPool.BadDeposit.selector);
        pool.open{value: 0.03 ether}();
    }

    function test_liquidationPaysTheKeeperFromTheVictimsEquity() public {
        uint256 id = _open();
        vm.prank(USER);
        pool.glitch(id, 285);
        assertLt(pool.healthFactor(id), 1e18);
        pool.liquidate(id);

        uint256 profit = KEEPER.balance;
        assertGt(profit, 0.0025 ether);
        assertApproxEqAbs(pool.equity(id) + profit, DEPOSIT, 10);
        vm.prank(USER);
        pool.close(id);
        assertEq(address(pool).balance < 10, true, "the pool keeps nothing");
    }

    function test_refundArrivesAsNativeEth_andRestoresMostOfTheLoss() public {
        uint256 id = _open();
        vm.prank(USER);
        pool.glitch(id, 285);
        uint256 collateralBefore = _collateral(id);
        uint256 debtBefore = _debt(id);
        pool.liquidate(id);
        uint256 seized = collateralBefore - _collateral(id);
        uint256 repaid = debtBefore - _debt(id);

        Verdict memory v;
        v.liquidationTx = keccak256("tx");
        v.user = USER;
        v.debtToCover = repaid;
        v.collateralSeized = seized;
        v.bandLowE18 = 1.227e18;
        v.bandHighE18 = 1.23e18;
        v.debtPriceHighE18 = 1e18;
        v.liquidationBonusBps = 100;
        v.verdict = 1;
        v.oracleAdapter = ADAPTER;
        v.liquidator = KEEPER;
        v.builder = address(0xB1);
        v.redress = VerdictMath.computeRedress(1, seized, repaid, v.bandLowE18, 1e18, 100);

        uint256 before = USER.balance;
        vm.prank(FORWARDER);
        vault.onReport("", abi.encode(v));

        assertEq(USER.balance, before + v.redress, "native ETH reached the wallet");
        assertEq(weth.balanceOf(USER), 0);
        assertEq(vault.totalPaidFromBond(), v.redress);
        assertEq(ledger.claimOf(v.liquidationTx, 0).liquidator, KEEPER);

        vm.prank(USER);
        pool.close(id);
        assertGt(USER.balance, 1 ether - 0.0002 ether, "the wallet ends close to where it began");
    }

    function test_autoUnwrapIsOwnerOnly_andOthersStayTokens() public {
        vm.prank(USER);
        vm.expectRevert(DemoWETH.OnlyOwner.selector);
        weth.setAutoUnwrap(USER);

        vm.prank(USER);
        weth.deposit{value: 1}();
        vm.prank(USER);
        weth.transfer(address(0xCAFE), 1);
        assertEq(weth.balanceOf(address(0xCAFE)), 1);
    }

    function _collateral(uint256 id) private view returns (uint256 c) {
        (, c,,,) = pool.positions(id);
    }

    function _debt(uint256 id) private view returns (uint256 d) {
        (,, d,,) = pool.positions(id);
    }

    receive() external payable {}
}
