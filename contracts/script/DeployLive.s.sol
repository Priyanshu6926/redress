// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {DemoLendingPool} from "../src/demo/DemoLendingPool.sol";
import {DemoWETH} from "../src/demo/DemoWETH.sol";
import {OperatorBond} from "../src/OperatorBond.sol";
import {RecoveryLedger} from "../src/RecoveryLedger.sol";
import {RedressVault} from "../src/RedressVault.sol";

/// Deploys the live demo on Sepolia: a test lending pool and its own bond, ledger and vault,
/// funded with real test ETH. The pool's address doubles as the bonded oracle adapter.
contract DeployLiveScript is Script {
    function run() external {
        require(block.chainid == 11155111, "not Sepolia");
        address forwarder = vm.envAddress("CRE_FORWARDER");
        uint256 reserve = vm.envUint("RESERVE_WEI");
        uint256 bonded = vm.envUint("BOND_WEI");

        vm.startBroadcast();
        DemoWETH weth = new DemoWETH();
        DemoLendingPool pool = new DemoLendingPool(msg.sender, address(1), address(weth));

        address predicted = vm.computeCreateAddress(msg.sender, vm.getNonce(msg.sender) + 2);
        OperatorBond bond = new OperatorBond(predicted, address(weth), msg.sender, 7 days, 1 days);
        RecoveryLedger ledger = new RecoveryLedger(predicted, address(weth));
        RedressVault vault = new RedressVault(
            RedressVault.Config({
                forwarder: forwarder,
                payoutAsset: address(weth),
                maxLiquidationBonusBps: 2_000,
                epochCapBps: 2_000,
                epochLength: 1 days,
                expectedWorkflowId: bytes32(0), // the mock forwarder sends no metadata
                expectedWorkflowOwner: address(0),
                bond: address(bond),
                ledger: address(ledger)
            })
        );
        require(address(vault) == predicted, "vault address differs from prediction");

        weth.setAutoUnwrap(address(vault));
        weth.setAutoUnwrap(address(bond));
        weth.deposit{value: reserve + bonded}();
        weth.approve(address(vault), reserve);
        vault.fund(reserve);
        bond.registerOperator(address(pool), msg.sender); // the demo operator
        weth.approve(address(bond), bonded);
        bond.deposit(address(pool), bonded);
        vm.stopBroadcast();
    }
}
