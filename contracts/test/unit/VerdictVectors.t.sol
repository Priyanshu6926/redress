// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";

/// Checks VerdictMath against the vector file shared with verdict.test.ts.
contract VerdictVectorsTest is Test {
    function test_sharedVectors() public view {
        string memory json = vm.readFile("test/vectors/redress-vectors.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGt(count, 0);

        for (uint256 i = 0; i < count; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            uint256 got = VerdictMath.computeRedress(
                uint8(vm.parseJsonUint(json, string.concat(p, ".verdict"))),
                vm.parseJsonUint(json, string.concat(p, ".collateralSeized")),
                vm.parseJsonUint(json, string.concat(p, ".debtToCover")),
                vm.parseJsonUint(json, string.concat(p, ".bandLowE18")),
                vm.parseJsonUint(json, string.concat(p, ".debtPriceHighE18")),
                vm.parseJsonUint(json, string.concat(p, ".bonusBps"))
            );
            assertEq(got, vm.parseJsonUint(json, string.concat(p, ".redress")), vm.parseJsonString(json, string.concat(p, ".name")));
        }
    }
}
