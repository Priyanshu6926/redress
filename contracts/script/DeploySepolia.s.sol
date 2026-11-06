// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {RedressVault} from "../src/RedressVault.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";

/// Deploys test WETH and the vault on Sepolia and funds the reserve. No timelock is deployed:
/// vault parameters are immutable. Refuses to run on any other chain, and until VERIFY.md's
/// deployment blockers are cleared.
contract DeploySepoliaScript is Script {
    uint256 private constant SEPOLIA = 11155111;

    function run() external returns (MockWETH weth, RedressVault vault) {
        require(block.chainid == SEPOLIA, "not Sepolia");
        require(vm.envOr("VERIFY_CLEARED", false), "VERIFY.md has open deployment items");

        uint256 reserve = vm.envOr("RESERVE_WEI", uint256(3_000 ether));
        address forwarder = vm.envAddress("CRE_FORWARDER");

        vm.startBroadcast();
        weth = new MockWETH();
        vault = new RedressVault(
            RedressVault.Config({
                forwarder: forwarder,
                payoutAsset: address(weth),
                maxLiquidationBonusBps: vm.envOr("MAX_LIQUIDATION_BONUS_BPS", uint256(2_000)),
                epochCapBps: vm.envOr("EPOCH_CAP_BPS", uint256(2_000)),
                epochLength: vm.envOr("EPOCH_LENGTH_SEC", uint256(1 days)),
                expectedWorkflowId: bytes32(0), // the mock forwarder sends no metadata
                expectedWorkflowOwner: address(0)
            })
        );
        weth.mint(msg.sender, reserve);
        weth.approve(address(vault), reserve);
        vault.fund(reserve);
        vm.stopBroadcast();
    }
}
