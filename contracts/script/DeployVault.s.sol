// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {RedressVault} from "../src/RedressVault.sol";

/// Deploys the vault. Every address comes from the environment, and the script refuses to
/// run until VERIFY.md has no open blocking item and VERIFY_CLEARED=true is set.
contract DeployVaultScript is Script {
    function run() external returns (RedressVault vault) {
        require(vm.envOr("VERIFY_CLEARED", false), "VERIFY.md has open items: deployment is blocked");

        RedressVault.Config memory cfg = RedressVault.Config({
            forwarder: vm.envAddress("CRE_FORWARDER"),
            payoutAsset: vm.envAddress("PAYOUT_ASSET"),
            maxLiquidationBonusBps: vm.envOr("MAX_LIQUIDATION_BONUS_BPS", uint256(2_000)),
            epochCapBps: vm.envOr("EPOCH_CAP_BPS", uint256(2_000)),
            epochLength: vm.envOr("EPOCH_LENGTH_SEC", uint256(1 days)),
            expectedWorkflowId: vm.envOr("EXPECTED_WORKFLOW_ID", bytes32(0)),
            expectedWorkflowOwner: vm.envOr("EXPECTED_WORKFLOW_OWNER", address(0)),
            bond: address(0),
            ledger: address(0)
        });

        vm.startBroadcast();
        vault = new RedressVault(cfg);
        vm.stopBroadcast();
    }
}
