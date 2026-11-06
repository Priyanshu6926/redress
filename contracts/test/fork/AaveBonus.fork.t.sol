// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RedressVault} from "../../src/RedressVault.sol";

interface IAavePool {
    struct CollateralConfig {
        uint16 ltv;
        uint16 liquidationThreshold;
        uint16 liquidationBonus;
    }

    struct ReserveDataLegacy {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getUserEMode(address user) external view returns (uint256);
    function getEModeCategoryCollateralConfig(uint8 id) external view returns (CollateralConfig memory);
    function getEModeCategoryCollateralBitmap(uint8 id) external view returns (uint128);
    function getConfiguration(address asset) external view returns (uint256);
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}

/// Checks the bonus in every incident report against Aave's real configuration at block - 1.
/// Needs MAINNET_RPC with archive access; skipped without it.
contract AaveBonusForkTest is Test {
    using stdJson for string;

    address private constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address private constant CORE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant PRIME = 0x4e033931ad43597d96D6bcc25c280717730B58B1;
    uint256 private constant FORK_BLOCK = 24626859;

    function _reserveBonus(IAavePool pool) private view returns (uint256) {
        return (pool.getConfiguration(WSTETH) >> 32) & 0xffff;
    }

    /// The bonus Aave's LiquidationLogic would apply to this user's wstETH.
    function _effectiveRawBonus(IAavePool pool, address user) private view returns (uint256 raw, bool fromCategory) {
        uint256 category = pool.getUserEMode(user);
        if (category != 0) {
            uint256 id = pool.getReserveData(WSTETH).id;
            if ((uint256(pool.getEModeCategoryCollateralBitmap(uint8(category))) >> id) & 1 == 1) {
                return (pool.getEModeCategoryCollateralConfig(uint8(category)).liquidationBonus, true);
            }
        }
        return (_reserveBonus(pool), false);
    }

    function _skipWithoutRpc() private returns (string memory rpc) {
        rpc = vm.envOr("MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
    }

    function test_reserveAndCategoryBonusesMatchAave() public {
        vm.createSelectFork(_skipWithoutRpc(), FORK_BLOCK);
        assertEq(_reserveBonus(IAavePool(CORE)), 10_600);
        assertEq(_reserveBonus(IAavePool(PRIME)), 10_600);
        assertEq(IAavePool(CORE).getEModeCategoryCollateralConfig(1).liquidationBonus, 10_100);
        assertEq(IAavePool(PRIME).getEModeCategoryCollateralConfig(1).liquidationBonus, 10_100);
    }

    function test_everyReportedBonusMatchesAaveAndPassesTheVaultBound() public {
        string memory rpc = _skipWithoutRpc();
        string memory json = vm.readFile("../replay/data/incident-reads.json");
        uint256 maxBonus = new RedressVault(address(1)).MAX_LIQUIDATION_BONUS_BPS();
        vm.createSelectFork(rpc, FORK_BLOCK);

        uint256 categoryEvents;
        uint256 reserveEvents;
        uint256 currentBlock = FORK_BLOCK;
        for (uint256 i = 0; i < 47; i++) {
            string memory p = string.concat("$[", vm.toString(i), "]");
            uint256 preBlock = json.readUint(string.concat(p, ".blockNumber")) - 1;
            if (preBlock != currentBlock) {
                vm.rollFork(preBlock);
                currentBlock = preBlock;
            }
            IAavePool pool = IAavePool(json.readAddress(string.concat(p, ".pool")));
            address user = json.readAddress(string.concat(p, ".user"));
            uint256 reported = json.readUint(string.concat(p, ".bonusBps"));

            (uint256 raw, bool fromCategory) = _effectiveRawBonus(pool, user);
            assertEq(reported, raw - 10_000, vm.toString(user));
            assertLe(reported, maxBonus);
            if (fromCategory) categoryEvents++;
            else reserveEvents++;
        }
        assertEq(categoryEvents, 46);
        assertEq(reserveEvents, 1);
    }
}
