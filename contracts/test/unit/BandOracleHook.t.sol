// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {BandOracleHook} from "../../src/hooks/BandOracleHook.sol";

contract BandOracleHookTest is Test, Deployers {
    using StateLibrary for *;

    BandOracleHook hook;
    PoolKey poolKey;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address flags = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) ^ (0x4444 << 144));
        deployCodeTo("BandOracleHook.sol:BandOracleHook", abi.encode(manager), flags);
        hook = BandOracleHook(flags);

        vm.warp(1_000_000);
        (poolKey,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
    }

    function _swap(bool zeroForOne, int256 amount) private {
        swap(poolKey, zeroForOne, amount, ZERO_BYTES);
    }

    function _tick() private view returns (int24 tick) {
        (, tick,,) = StateLibrary.getSlot0(manager, poolKey.toId());
    }

    function test_records_atInitialize() public view {
        assertEq(hook.observationCount(poolKey), 1);
        BandOracleHook.Band memory band = hook.getBand(poolKey, 60);
        assertEq(band.twapTick, 0);
        assertEq(band.minTick, 0);
        assertEq(band.maxTick, 0);
        assertEq(band.count, 1);
    }

    function test_records_preSwapTick_notPostSwapTick() public {
        vm.warp(block.timestamp + 10);
        _swap(true, -0.002 ether);
        int24 moved = _tick();
        assertLt(moved, 0, "swap must move the price");

        // The swap that moved the price was recorded at its pre-swap tick.
        BandOracleHook.Band memory band = hook.getBand(poolKey, 3600);
        assertEq(band.minTick, 0);
        assertEq(band.maxTick, 0);
        assertEq(band.count, 2);
    }

    function test_oneObservationPerBlock() public {
        vm.warp(block.timestamp + 10);
        _swap(true, -0.002 ether);
        _swap(true, -0.002 ether);
        _swap(false, -0.002 ether);
        assertEq(hook.observationCount(poolKey), 2);
    }

    function test_movedTickAppearsOnlyAtTheNextBlock() public {
        vm.warp(block.timestamp + 10);
        _swap(true, -0.002 ether);
        int24 moved = _tick();

        vm.warp(block.timestamp + 10);
        _swap(false, -0.00001 ether);
        assertEq(hook.getBand(poolKey, 3600).minTick, moved);
    }

    function test_sandwichWithinOneBlockLeavesNoTrace() public {
        vm.warp(block.timestamp + 10);
        _swap(true, -0.002 ether); // push the price down
        _swap(false, -0.00201 ether); // and back in the same block
        int24 restored = _tick();

        vm.warp(block.timestamp + 10);
        _swap(true, -0.00001 ether);
        BandOracleHook.Band memory band = hook.getBand(poolKey, 3600);
        assertEq(band.minTick, restored < 0 ? restored : int24(0), "only block-end prices count");
    }

    function test_twapIsTimeWeighted() public {
        vm.warp(1_000_000 + 100);
        _swap(true, -0.002 ether);
        int24 moved = _tick();

        vm.warp(1_000_000 + 400);
        _swap(false, -0.00001 ether);

        // 100s at tick 0, then 300s at `moved`.
        BandOracleHook.Band memory band = hook.getBand(poolKey, 400);
        int256 expected = (int256(moved) * 300) / 400;
        if ((int256(moved) * 300) % 400 != 0) expected -= 1;
        assertEq(int256(band.twapTick), expected);
        assertEq(band.coveredSeconds, 400);
        assertLt(band.twapTick, 0, "a held price must move the TWAP");
    }

    function test_windowStartsInsideAnEarlierObservation() public {
        vm.warp(1_000_000 + 100);
        _swap(true, -0.002 ether);
        int24 moved = _tick();
        vm.warp(1_000_000 + 200);
        _swap(false, -0.00001 ether);
        vm.warp(1_000_000 + 250);

        // The last 100s run from t=150, part way through the interval that `moved` held.
        BandOracleHook.Band memory band = hook.getBand(poolKey, 100);
        assertEq(band.coveredSeconds, 100);
        assertEq(band.minTick, moved);
    }

    function test_oldObservationsFallOutOfTheWindow() public {
        vm.warp(1_000_000 + 10);
        _swap(true, -0.002 ether);
        int24 moved = _tick();
        vm.warp(1_000_000 + 20);
        _swap(false, -0.00201 ether);
        int24 back = _tick();
        vm.warp(1_000_000 + 10_000);
        _swap(true, -0.00001 ether);

        BandOracleHook.Band memory band = hook.getBand(poolKey, 100);
        assertEq(band.minTick, back);
        assertGt(band.minTick, moved);
    }

    function test_quietPoolExtrapolatesTheEndOfBlockPrice() public {
        vm.warp(1_000_000 + 100);
        _swap(true, -0.002 ether);
        int24 moved = _tick();
        vm.warp(1_000_000 + 200);

        // No swap in this block, so the price the earlier block ended on is read.
        BandOracleHook.Band memory band = hook.getBand(poolKey, 100);
        assertEq(band.twapTick, moved);
        assertEq(band.count, 0, "a stale window holds no observations");
        assertEq(band.lastObservedAt, 1_000_000 + 100);
    }

    function test_shortHistoryIsReported() public {
        vm.warp(1_000_000 + 60);
        BandOracleHook.Band memory band = hook.getBand(poolKey, 3600);
        assertEq(band.coveredSeconds, 60);
        assertEq(band.lastObservedAt, 1_000_000);
    }

    function test_ringWrapsWithoutLosingTheNewest() public {
        uint256 cardinality = hook.CARDINALITY();
        for (uint256 i = 1; i <= cardinality + 5; i++) {
            vm.warp(1_000_000 + i * 12);
            _swap(i % 2 == 0, -0.00001 ether);
        }
        assertEq(hook.observationCount(poolKey), cardinality);
        BandOracleHook.Band memory band = hook.getBand(poolKey, type(uint32).max);
        assertEq(band.count, cardinality);
        assertEq(band.lastObservedAt, 1_000_000 + (cardinality + 5) * 12);
    }

    function test_singleLargeSwapMovesLongWindowTwapOnlySlightly() public {
        vm.warp(1_000_000 + 3_588);
        _swap(true, -0.02 ether); // a large swap, then one 12-second block at that price
        int24 moved = _tick();
        assertLt(moved, -100, "the swap must be large against this pool");

        vm.warp(1_000_000 + 3_600);
        _swap(false, -0.021 ether); // the attacker unwinds

        BandOracleHook.Band memory band = hook.getBand(poolKey, 3_600);
        assertEq(band.minTick, moved, "the band must still show the excursion");
        // 12 of 3,600 seconds at the moved tick: the TWAP moves by about 1/300 of it.
        assertLe(_abs(band.twapTick) * 100, _abs(moved), "TWAP must move under 1% of the spot move");
    }

    function _abs(int24 x) private pure returns (uint256) {
        return x < 0 ? uint256(uint24(-x)) : uint256(uint24(x));
    }

    function test_revertsOnUnknownPool() public {
        PoolKey memory unknown = poolKey;
        unknown.fee = 500;
        vm.expectRevert(BandOracleHook.UnknownPool.selector);
        hook.getBand(unknown, 60);
    }

    function test_revertsOnZeroWindow() public {
        vm.expectRevert(BandOracleHook.ZeroWindow.selector);
        hook.getBand(poolKey, 0);
    }

    function test_onlyPoolManagerCanRecord() public {
        SwapParams memory params;
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), poolKey, params, "");
    }

    function test_constructorRejectsAnAddressWithoutTheFlags() public {
        vm.expectPartialRevert(Hooks.HookAddressNotValid.selector);
        new BandOracleHook(manager);
    }
}
