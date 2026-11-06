// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RedressVault, Verdict} from "../../src/RedressVault.sol";

contract RedressVaultTest is Test {
    using stdJson for string;

    address private constant FORWARDER = address(0xF0);
    address private constant VICTIM = address(0xB1);
    uint8 private constant VALID = 0;
    uint8 private constant WRONGFUL = 1;
    uint8 private constant AMBIGUOUS = 3;

    RedressVault private vault;

    function setUp() public {
        vault = new RedressVault(FORWARDER);
        vm.deal(address(this), 100_000 ether);
        (bool ok,) = address(vault).call{value: 100_000 ether}("");
        require(ok, "funding failed");
    }

    /// C = 100, low = 1.2, X = 110, debt price 1: WRONGFUL pays 10, EXCESS or AMBIGUOUS at 1% pays 8.9.
    function _report(uint8 verdict, uint256 bonus, uint256 redress) private pure returns (Verdict memory v) {
        v.liquidationTx = keccak256("tx");
        v.logIndex = 1;
        v.blockNumber = 1;
        v.user = VICTIM;
        v.debtToCover = 110e18;
        v.collateralSeized = 100e18;
        v.bandLowE18 = 1.2e18;
        v.bandHighE18 = 1.21e18;
        v.debtPriceHighE18 = 1e18;
        v.liquidationBonusBps = bonus;
        v.verdict = verdict;
        v.sourceCount = 3;
        v.redress = redress;
    }

    function _send(Verdict memory v) private {
        vm.prank(FORWARDER);
        vault.onReport("", abi.encode(v));
    }

    function test_acceptsExactRedress() public {
        _send(_report(WRONGFUL, 100, 10e18));
        assertEq(VICTIM.balance, 10e18);
        assertEq(vault.totalPaid(), 10e18);
    }

    function test_oneWeiOverReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 10e18 + 1, 10e18));
        _send(_report(WRONGFUL, 100, 10e18 + 1));
    }

    function test_oneWeiUnderReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 10e18 - 1, 10e18));
        _send(_report(WRONGFUL, 100, 10e18 - 1));
    }

    function test_mismatchLeavesNoState() public {
        vm.expectRevert();
        _send(_report(WRONGFUL, 100, 1));
        assertFalse(vault.processed(keccak256("tx"), 1));
        assertEq(VICTIM.balance, 0);
        _send(_report(WRONGFUL, 100, 10e18));
        assertEq(VICTIM.balance, 10e18);
    }

    function test_nonPayingVerdictMustReportZero() public {
        _send(_report(VALID, 100, 0));
        assertEq(VICTIM.balance, 0);
        assertTrue(vault.processed(keccak256("tx"), 1));
    }

    function test_nonPayingVerdictWithRedressReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 1, 0));
        _send(_report(VALID, 100, 1));
    }

    function test_bonusIsTakenFromTheReport() public {
        // At 6% the entitlement is 116.6, so the excess is 3.4 rather than 8.9.
        _send(_report(AMBIGUOUS, 600, 3.4e18));
        assertEq(VICTIM.balance, 3.4e18);
    }

    function test_wrongBonusForTheAmountReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 3.4e18, 8.9e18));
        _send(_report(AMBIGUOUS, 100, 3.4e18));
    }

    function test_bonusAtTheMaximumIsAccepted() public {
        // Entitlement 110 * 1.2 = 132 exceeds the 120 collateral floor, so nothing is owed.
        _send(_report(AMBIGUOUS, vault.MAX_LIQUIDATION_BONUS_BPS(), 0));
    }

    function test_bonusAboveTheMaximumReverts() public {
        uint256 bonus = vault.MAX_LIQUIDATION_BONUS_BPS() + 1;
        vm.expectRevert(abi.encodeWithSelector(RedressVault.BonusOutOfBounds.selector, bonus));
        _send(_report(AMBIGUOUS, bonus, 0));
    }

    function test_bonusIsBoundedEvenWhenItCannotAffectThePayout() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.BonusOutOfBounds.selector, type(uint256).max));
        _send(_report(WRONGFUL, type(uint256).max, 10e18));
    }

    function test_duplicateReportReverts() public {
        _send(_report(WRONGFUL, 100, 10e18));
        vm.expectRevert("Already processed");
        _send(_report(WRONGFUL, 100, 10e18));
    }

    function testFuzz_anyOtherRedressReverts(uint256 reported) public {
        vm.assume(reported != 10e18);
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, reported, 10e18));
        _send(_report(WRONGFUL, 100, reported));
    }

    /// Reports encoded by report.ts from real incident rows. The vault must accept every one
    /// at exactly the TypeScript redress, which fails if the engines round differently.
    function test_acceptsEveryTypeScriptIncidentReport() public {
        string memory json = vm.readFile("test/report-fixture.json");
        uint256 count = json.readUint(".count");
        assertGt(count, 0);
        uint256 total;
        for (uint256 i = 0; i < count; i++) {
            string memory p = string.concat(".reports[", vm.toString(i), "]");
            vm.prank(FORWARDER);
            vault.onReport("", json.readBytes(string.concat(p, ".report")));
            total += json.readUint(string.concat(p, ".redress"));
        }
        assertEq(vault.totalPaid(), total);
        assertEq(total, json.readUint(".totalRedress"));
    }

    function test_rejectsTypeScriptReportsWithOneWeiAdded() public {
        string memory json = vm.readFile("test/report-fixture.json");
        Verdict memory v = abi.decode(json.readBytes(".reports[0].report"), (Verdict));
        v.redress += 1;
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, v.redress, v.redress - 1));
        _send(v);
    }
}
