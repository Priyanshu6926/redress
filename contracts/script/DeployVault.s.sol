// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/RedressVault.sol";
import "../src/OperatorBond.sol";
import "../src/RecoveryLedger.sol";

contract DeployVaultScript {
    function run() external {
        address forwarder = msg.sender;
        RedressVault vault = new RedressVault(forwarder);
        OperatorBond bond = new OperatorBond();
        RecoveryLedger ledger = new RecoveryLedger();

        vault.setDependencies(address(bond), address(ledger));
        bond.setVault(address(vault));
        ledger.setVault(address(vault));
    }
}

