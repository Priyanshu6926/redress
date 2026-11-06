// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {RedressVault} from "../src/RedressVault.sol";
import {OperatorBond} from "../src/OperatorBond.sol";
import {RecoveryLedger} from "../src/RecoveryLedger.sol";

/// Deploys the bond and ledger against the existing vault, with the broadcaster as attestor.
contract DeployAccountabilityScript is Script {
    function run() external returns (OperatorBond bond, RecoveryLedger ledger) {
        require(block.chainid == 11155111, "not Sepolia");
        RedressVault vault = RedressVault(vm.envAddress("VAULT"));
        vm.startBroadcast();
        bond = new OperatorBond(vault, msg.sender, 7 days);
        ledger = new RecoveryLedger(vault, msg.sender);
        vm.stopBroadcast();
    }
}
