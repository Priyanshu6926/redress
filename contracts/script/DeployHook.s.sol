// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/hooks/BandOracleHook.sol";

contract DeployHookScript {
    function run() external {
        new BandOracleHook();
    }
}

