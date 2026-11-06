// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {BandOracleHook} from "../src/hooks/BandOracleHook.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";

/// Mines the hook address, deploys the hook, and opens a test-token pool with liquidity.
/// Addresses come from the official v4 deployments page, recorded in VERIFY.md.
contract DeployHookScript is Script {
    IPoolManager private constant MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    PoolModifyLiquidityTest private constant LIQUIDITY =
        PoolModifyLiquidityTest(0x0C478023803a644c94c4CE1C1e7b9A087e411B0A);
    uint160 private constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function run() external returns (BandOracleHook hook, address token0, address token1) {
        require(block.chainid == 11155111, "not Sepolia");
        MockWETH payout = MockWETH(vm.envAddress("PAYOUT_ASSET"));

        uint160 flags = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
        (address mined, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(BandOracleHook).creationCode, abi.encode(MANAGER));

        vm.startBroadcast();
        hook = new BandOracleHook{salt: salt}(MANAGER);
        require(address(hook) == mined, "hook address differs from mined address");

        MockWETH other = new MockWETH();
        (token0, token1) = address(payout) < address(other)
            ? (address(payout), address(other))
            : (address(other), address(payout));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        MANAGER.initialize(key, SQRT_PRICE_1_1);

        payout.mint(msg.sender, 1_000 ether);
        other.mint(msg.sender, 1_000 ether);
        payout.approve(address(LIQUIDITY), type(uint256).max);
        other.approve(address(LIQUIDITY), type(uint256).max);
        LIQUIDITY.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1_000 ether, salt: 0}), ""
        );
        vm.stopBroadcast();
    }
}
