// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver - receives keystone reports
/// @notice Interface from https://docs.chain.link/samples/CRE/IReceiver.sol
interface IReceiver is IERC165 {
    /// @notice Handles incoming keystone reports.
    /// @dev If this call reverts it can be retried. The receiver discards stale reports.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
