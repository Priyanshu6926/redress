// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The vault pays from this first. `draw` pays out at most the adapter's bond.
interface IOperatorBond {
    function vault() external view returns (address);
    function asset() external view returns (address);
    function available(address adapter) external view returns (uint256);
    function draw(address adapter, uint256 amount, address recipient) external returns (uint256 paid);
}

/// Each payout opens a claim here. It must never revert on a call from the vault.
interface IRecoveryLedger {
    function vault() external view returns (address);
    function asset() external view returns (address);
    function openClaim(bytes32 liquidationTx, uint32 logIndex, address liquidator, address builder, uint256 expected)
        external;
}
