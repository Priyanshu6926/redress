// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Swaps in both directions so the band has observations. Run with --slow: one observation is
/// kept per block, so swaps must land in separate blocks.
contract SwapHookPoolScript is Script {
    PoolSwapTest private constant ROUTER = PoolSwapTest(0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe);

    function run() external {
        require(block.chainid == 11155111, "not Sepolia");
        address token0 = vm.envAddress("TOKEN0");
        address token1 = vm.envAddress("TOKEN1");
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(vm.envAddress("HOOK"))
        });
        PoolSwapTest.TestSettings memory settings =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

        vm.startBroadcast();
        IERC20(token0).approve(address(ROUTER), type(uint256).max);
        IERC20(token1).approve(address(ROUTER), type(uint256).max);
        for (uint256 i = 0; i < 6; i++) {
            bool zeroForOne = i % 2 == 0;
            ROUTER.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256((i + 1) * 1 ether),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                settings,
                ""
            );
        }
        vm.stopBroadcast();
    }
}
