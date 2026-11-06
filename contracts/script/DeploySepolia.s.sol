// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {OperatorBond} from "../src/OperatorBond.sol";
import {RecoveryLedger} from "../src/RecoveryLedger.sol";
import {RedressVault} from "../src/RedressVault.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";

/// Deploys the bond, ledger and vault on Sepolia, funds the reserve, and posts the demo
/// operator's bond. The bond and ledger are deployed first against the vault's predicted address,
/// so no contract has a setter. Vault parameters are immutable, so there is no timelock.
contract DeploySepoliaScript is Script {
    uint256 private constant SEPOLIA = 11155111;

    function run() external returns (MockWETH weth, OperatorBond bond, RecoveryLedger ledger, RedressVault vault) {
        require(block.chainid == SEPOLIA, "not Sepolia");
        require(vm.envOr("VERIFY_CLEARED", false), "VERIFY.md has open deployment items");

        uint256 reserve = vm.envOr("RESERVE_WEI", uint256(3_000 ether));
        uint256 bonded = vm.envOr("BOND_WEI", uint256(100 ether));
        address adapter = vm.envAddress("ORACLE_ADAPTER");
        address forwarder = vm.envAddress("CRE_FORWARDER");
        address existing = vm.envOr("PAYOUT_ASSET", address(0));

        vm.startBroadcast();
        weth = existing == address(0) ? new MockWETH() : MockWETH(existing);

        address predicted = vm.computeCreateAddress(msg.sender, vm.getNonce(msg.sender) + 2);
        bond = new OperatorBond(predicted, address(weth), msg.sender, 7 days, 1 days);
        ledger = new RecoveryLedger(predicted, address(weth));
        vault = new RedressVault(
            RedressVault.Config({
                forwarder: forwarder,
                payoutAsset: address(weth),
                maxLiquidationBonusBps: vm.envOr("MAX_LIQUIDATION_BONUS_BPS", uint256(2_000)),
                epochCapBps: vm.envOr("EPOCH_CAP_BPS", uint256(2_000)),
                epochLength: vm.envOr("EPOCH_LENGTH_SEC", uint256(1 days)),
                expectedWorkflowId: bytes32(0), // the mock forwarder sends no metadata
                expectedWorkflowOwner: address(0),
                bond: address(bond),
                ledger: address(ledger)
            })
        );
        require(address(vault) == predicted, "vault address differs from prediction");

        weth.mint(msg.sender, reserve + bonded);
        weth.approve(address(vault), reserve);
        vault.fund(reserve);
        bond.registerOperator(adapter, msg.sender); // the demo operator
        weth.approve(address(bond), bonded);
        bond.deposit(adapter, bonded);
        vm.stopBroadcast();
    }
}
