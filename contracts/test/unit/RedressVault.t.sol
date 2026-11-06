// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {IRedressVault, RedressVault, Verdict} from "../../src/RedressVault.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";

contract RedressVaultTest is Test {
    using stdJson for string;

    address private constant FORWARDER = address(0xF0);
    address private constant VICTIM = address(0xB1);
    address private constant STRANGER = address(0xBAD);
    uint8 private constant VALID = 0;
    uint8 private constant WRONGFUL = 1;
    uint8 private constant EXCESS = 2;
    uint8 private constant AMBIGUOUS = 3;
    uint8 private constant INCONCLUSIVE = 4;
    uint8 private constant OVERPRICED = 5;
    uint256 private constant MAX_BONUS = 2_000;
    uint256 private constant EPOCH = 1 days;

    MockWETH private weth;
    RedressVault private vault;

    function setUp() public {
        vm.warp(1_000 days);
        weth = new MockWETH();
        vault = _deploy(10_000, bytes32(0), address(0));
        _fund(vault, 100_000 ether);
    }

    function _deploy(uint256 capBps, bytes32 id, address workflowOwner) private returns (RedressVault) {
        return new RedressVault(
            RedressVault.Config({
                forwarder: FORWARDER,
                payoutAsset: address(weth),
                maxLiquidationBonusBps: MAX_BONUS,
                epochCapBps: capBps,
                epochLength: EPOCH,
                expectedWorkflowId: id,
                expectedWorkflowOwner: workflowOwner,
                bond: address(0),
                ledger: address(0)
            })
        );
    }

    function _fund(RedressVault target, uint256 amount) private {
        weth.mint(address(this), amount);
        weth.approve(address(target), amount);
        target.fund(amount);
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
        v.evidenceHash = keccak256("evidence");
    }

    function _send(RedressVault target, Verdict memory v) private {
        vm.prank(FORWARDER);
        target.onReport("", abi.encode(v));
    }

    function _send(Verdict memory v) private {
        _send(vault, v);
    }

    // Construction

    function test_constructorRejectsBadConfig() public {
        RedressVault.Config memory good = RedressVault.Config(
            FORWARDER, address(weth), MAX_BONUS, 2000, EPOCH, 0, address(0), address(0), address(0)
        );
        RedressVault.Config memory c = RedressVault.Config(
            address(0), address(weth), MAX_BONUS, 2000, EPOCH, 0, address(0), address(0), address(0)
        );
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(c);

        c = RedressVault.Config(FORWARDER, address(0), MAX_BONUS, 2000, EPOCH, 0, address(0), address(0), address(0));
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(c);

        c = RedressVault.Config(FORWARDER, address(weth), 10_001, 2000, EPOCH, 0, address(0), address(0), address(0));
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(c);

        c = RedressVault.Config(FORWARDER, address(weth), MAX_BONUS, 0, EPOCH, 0, address(0), address(0), address(0));
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(c);

        c = RedressVault.Config(
            FORWARDER, address(weth), MAX_BONUS, 10_001, EPOCH, 0, address(0), address(0), address(0)
        );
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(c);

        c = RedressVault.Config(FORWARDER, address(weth), MAX_BONUS, 2000, 0, 0, address(0), address(0), address(0));
        vm.expectRevert(RedressVault.InvalidConfig.selector);
        new RedressVault(c);

        new RedressVault(good);
    }

    function test_supportsReceiverInterfaces() public view {
        assertTrue(vault.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(vault.supportsInterface(type(IERC165).interfaceId));
        assertFalse(vault.supportsInterface(0xdeadbeef));
    }

    // Authorization

    function test_nonForwarderReverts() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(RedressVault.InvalidSender.selector, STRANGER, FORWARDER));
        vault.onReport("", abi.encode(_report(WRONGFUL, 100, 10e18)));
    }

    function test_ownerCannotDeliverReports() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.InvalidSender.selector, address(this), FORWARDER));
        vault.onReport("", abi.encode(_report(WRONGFUL, 100, 10e18)));
    }

    function _metadata(bytes32 id, address workflowOwner, bool withReportId) private pure returns (bytes memory) {
        bytes memory base = abi.encodePacked(id, bytes10("name"), workflowOwner);
        return withReportId ? abi.encodePacked(base, bytes2(0x0001)) : base;
    }

    function test_workflowIdentityAcceptsBothDocumentedMetadataLengths() public {
        RedressVault strict = _deploy(10_000, keccak256("wf"), address(0xA1));
        _fund(strict, 100 ether);

        Verdict memory first = _report(WRONGFUL, 100, 10e18);
        vm.prank(FORWARDER);
        strict.onReport(_metadata(keccak256("wf"), address(0xA1), true), abi.encode(first));

        first.logIndex = 2;
        vm.prank(FORWARDER);
        strict.onReport(_metadata(keccak256("wf"), address(0xA1), false), abi.encode(first));
        assertEq(weth.balanceOf(VICTIM), 20e18);
    }

    function test_wrongWorkflowIdReverts() public {
        RedressVault strict = _deploy(10_000, keccak256("wf"), address(0));
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(RedressVault.InvalidWorkflowId.selector, keccak256("other"), keccak256("wf"))
        );
        strict.onReport(_metadata(keccak256("other"), address(0xA1), true), abi.encode(_report(WRONGFUL, 100, 10e18)));
    }

    function test_wrongWorkflowOwnerReverts() public {
        RedressVault strict = _deploy(10_000, bytes32(0), address(0xA1));
        vm.prank(FORWARDER);
        vm.expectRevert(
            abi.encodeWithSelector(RedressVault.InvalidWorkflowOwner.selector, address(0xA2), address(0xA1))
        );
        strict.onReport(_metadata(keccak256("wf"), address(0xA2), true), abi.encode(_report(WRONGFUL, 100, 10e18)));
    }

    function test_shortMetadataRevertsWhenIdentityIsRequired() public {
        RedressVault strict = _deploy(10_000, keccak256("wf"), address(0));
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RedressVault.MetadataTooShort.selector, 61));
        strict.onReport(new bytes(61), abi.encode(_report(WRONGFUL, 100, 10e18)));
    }

    // Strict equality and the bonus

    function test_acceptsExactRedress() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IRedressVault.Attested(keccak256("tx"), 1, VICTIM, WRONGFUL, 10e18, keccak256("evidence"));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IRedressVault.Paid(keccak256("tx"), VICTIM, address(weth), 10e18, 1);
        _send(_report(WRONGFUL, 100, 10e18));
        assertEq(weth.balanceOf(VICTIM), 10e18);
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

    function test_revertedReportLeavesNoState() public {
        vm.expectRevert();
        _send(_report(WRONGFUL, 100, 1));
        assertFalse(vault.recordOf(keccak256("tx"), 1).attested);
        _send(_report(WRONGFUL, 100, 10e18));
        assertEq(weth.balanceOf(VICTIM), 10e18);
    }

    function test_bonusIsTakenFromTheReport() public {
        // At 6% the entitlement is 116.6, so the excess is 3.4 rather than 8.9.
        _send(_report(AMBIGUOUS, 600, 3.4e18));
        assertEq(weth.balanceOf(VICTIM), 3.4e18);
    }

    function test_wrongBonusForTheAmountReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 3.4e18, 8.9e18));
        _send(_report(AMBIGUOUS, 100, 3.4e18));
    }

    function test_bonusAtTheMaximumIsAccepted() public {
        // Entitlement 110 * 1.2 = 132 exceeds the 120 collateral floor, so nothing is owed.
        _send(_report(AMBIGUOUS, MAX_BONUS, 0));
    }

    function test_bonusAboveTheMaximumReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.BonusOutOfBounds.selector, MAX_BONUS + 1));
        _send(_report(AMBIGUOUS, MAX_BONUS + 1, 0));
    }

    function test_bonusIsBoundedEvenWhenItCannotAffectThePayout() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.BonusOutOfBounds.selector, type(uint256).max));
        _send(_report(WRONGFUL, type(uint256).max, 10e18));
    }

    // Which verdicts pay

    function test_excessAndAmbiguousPayTheExcess() public {
        _send(_report(EXCESS, 100, 8.9e18));
        Verdict memory second = _report(AMBIGUOUS, 100, 8.9e18);
        second.logIndex = 2;
        _send(second);
        assertEq(weth.balanceOf(VICTIM), 17.8e18);
    }

    function test_nonPayingVerdictsAreStoredAndPayNothing() public {
        uint8[3] memory codes = [VALID, INCONCLUSIVE, OVERPRICED];
        for (uint32 i = 0; i < 3; i++) {
            Verdict memory v = _report(codes[i], 100, 0);
            v.logIndex = i + 10;
            _send(v);
            RedressVault.Record memory r = vault.recordOf(v.liquidationTx, v.logIndex);
            assertTrue(r.attested);
            assertEq(r.verdict, codes[i]);
            assertEq(r.evidenceHash, keccak256("evidence"));
        }
        assertEq(weth.balanceOf(VICTIM), 0);
        assertEq(vault.totalPaid(), 0);
    }

    function test_nonPayingVerdictWithRedressReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 1, 0));
        _send(_report(VALID, 100, 1));
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, 1, 0));
        _send(_report(OVERPRICED, 100, 1));
    }

    function test_wrongfulWithNoProvableLossIsStoredAndPaysNothing() public {
        Verdict memory v = _report(WRONGFUL, 100, 0);
        v.collateralSeized = 50e18; // 60 of collateral against 110 of debt
        _send(v);
        assertTrue(vault.recordOf(v.liquidationTx, v.logIndex).attested);
        assertEq(vault.totalPaid(), 0);
    }

    function test_paymentToZeroAddressReverts() public {
        Verdict memory v = _report(WRONGFUL, 100, 10e18);
        v.user = address(0);
        vm.expectRevert(RedressVault.InvalidRecipient.selector);
        _send(v);
    }

    function test_duplicateReportReverts() public {
        _send(_report(WRONGFUL, 100, 10e18));
        vm.expectRevert(abi.encodeWithSelector(RedressVault.AlreadyProcessed.selector, keccak256("tx"), uint32(1)));
        _send(_report(WRONGFUL, 100, 10e18));
    }

    function test_sameTxDifferentLogIndexIsSeparate() public {
        _send(_report(WRONGFUL, 100, 10e18));
        Verdict memory v = _report(WRONGFUL, 100, 10e18);
        v.logIndex = 2;
        _send(v);
        assertEq(weth.balanceOf(VICTIM), 20e18);
    }

    // Reserve, epoch cap, queue

    function test_directTransfersAreNotReserve() public {
        RedressVault fresh = _deploy(10_000, bytes32(0), address(0));
        weth.mint(address(fresh), 50 ether);
        assertEq(fresh.available(), 0);
        _send(fresh, _report(WRONGFUL, 100, 10e18));
        assertEq(weth.balanceOf(VICTIM), 0);
        assertFalse(fresh.recordOf(keccak256("tx"), 1).paid);
    }

    function test_epochCapQueuesThenSettlesNextEpoch() public {
        RedressVault capped = _deploy(2_000, bytes32(0), address(0));
        _fund(capped, 100e18); // 20 per epoch

        for (uint32 i = 1; i <= 3; i++) {
            Verdict memory v = _report(WRONGFUL, 100, 10e18);
            v.logIndex = i;
            if (i == 3) {
                vm.expectEmit(true, true, true, true, address(capped));
                emit IRedressVault.Queued(keccak256("tx"), 3, VICTIM, 10e18);
            }
            _send(capped, v);
        }
        assertEq(capped.totalPaid(), 20e18);
        assertFalse(capped.recordOf(keccak256("tx"), 3).paid);

        vm.expectRevert(RedressVault.NotPayable.selector);
        capped.settle(keccak256("tx"), 3);

        vm.warp(block.timestamp + EPOCH);
        vm.prank(STRANGER);
        capped.settle(keccak256("tx"), 3);
        assertEq(weth.balanceOf(VICTIM), 30e18);
        assertEq(weth.balanceOf(STRANGER), 0);
    }

    function test_fundingRaisesTheCurrentEpochBudget() public {
        RedressVault capped = _deploy(2_000, bytes32(0), address(0));
        _send(capped, _report(WRONGFUL, 100, 10e18));
        assertEq(capped.totalPaid(), 0);
        _fund(capped, 50e18);
        capped.settle(keccak256("tx"), 1);
        assertEq(capped.totalPaid(), 10e18);
    }

    function test_settleCannotPayTwiceOrPayNothing() public {
        vm.expectRevert(RedressVault.NothingToSettle.selector);
        vault.settle(keccak256("unknown"), 1);

        _send(_report(WRONGFUL, 100, 10e18));
        vm.expectRevert(RedressVault.NothingToSettle.selector);
        vault.settle(keccak256("tx"), 1);

        Verdict memory valid = _report(VALID, 100, 0);
        valid.logIndex = 2;
        _send(valid);
        vm.expectRevert(RedressVault.NothingToSettle.selector);
        vault.settle(keccak256("tx"), 2);
    }

    // Pause

    function test_onlyOwnerCanPause() public {
        vm.prank(STRANGER);
        vm.expectRevert(RedressVault.OnlyOwner.selector);
        vault.setPaused(true);
    }

    function test_pauseRecordsVerdictsButStopsPayouts() public {
        vault.setPaused(true);
        _send(_report(WRONGFUL, 100, 10e18));
        assertTrue(vault.recordOf(keccak256("tx"), 1).attested);
        assertEq(weth.balanceOf(VICTIM), 0);

        vm.expectRevert(RedressVault.IsPaused.selector);
        vault.settle(keccak256("tx"), 1);

        vault.setPaused(false);
        vault.settle(keccak256("tx"), 1);
        assertEq(weth.balanceOf(VICTIM), 10e18);
    }

    // Fuzz

    function testFuzz_anyOtherRedressReverts(uint256 reported) public {
        vm.assume(reported != 10e18);
        vm.expectRevert(abi.encodeWithSelector(RedressVault.RedressMismatch.selector, reported, 10e18));
        _send(_report(WRONGFUL, 100, reported));
    }

    function testFuzz_anyCallerButTheForwarderReverts(address caller) public {
        vm.assume(caller != FORWARDER);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(RedressVault.InvalidSender.selector, caller, FORWARDER));
        vault.onReport("", abi.encode(_report(WRONGFUL, 100, 10e18)));
    }

    function testFuzz_reports(uint8 code, uint256 c, uint256 x, uint256 low, uint256 debtHigh, uint256 bonus) public {
        Verdict memory v = _report(uint8(bound(code, 0, 7)), bound(bonus, 0, MAX_BONUS), 0);
        v.collateralSeized = bound(c, 0, 1e24);
        v.debtToCover = bound(x, 0, 1e24);
        v.bandLowE18 = bound(low, 1, 1e20);
        v.debtPriceHighE18 = bound(debtHigh, 1, 1e20);
        v.redress = VerdictMath.computeRedress(
            v.verdict, v.collateralSeized, v.debtToCover, v.bandLowE18, v.debtPriceHighE18, v.liquidationBonusBps
        );

        uint256 before = weth.balanceOf(VICTIM);
        _send(v);
        RedressVault.Record memory r = vault.recordOf(v.liquidationTx, v.logIndex);

        assertTrue(r.attested);
        assertLe(r.redress, v.collateralSeized * v.bandLowE18 / 1e18);
        bool pays = v.verdict == WRONGFUL || v.verdict == EXCESS || v.verdict == AMBIGUOUS;
        if (!pays) assertEq(r.redress, 0);
        if (r.paid) assertEq(weth.balanceOf(VICTIM) - before, r.redress);
        else assertEq(weth.balanceOf(VICTIM), before);
    }

    // Replays

    /// Every shared vector, through onReport, at the Python reference's redress.
    function test_replaysEveryVector() public {
        string memory json = vm.readFile("test/vectors.json");
        uint256 count = json.readUint(".count");
        uint256 total;
        uint256 paying;
        for (uint256 i = 0; i < count; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            Verdict memory v;
            v.liquidationTx = keccak256(abi.encode(i));
            v.user = VICTIM;
            v.collateralSeized = json.readUint(string.concat(p, ".C"));
            v.debtToCover = json.readUint(string.concat(p, ".X"));
            v.bandLowE18 = json.readUint(string.concat(p, ".expected.low"));
            v.bandHighE18 = json.readUint(string.concat(p, ".expected.high"));
            v.debtPriceHighE18 = json.readUint(string.concat(p, ".debtHigh"));
            v.liquidationBonusBps = json.readUint(string.concat(p, ".bonusBps"));
            v.verdict = uint8(json.readUint(string.concat(p, ".expected.verdict")));
            v.redress = json.readUint(string.concat(p, ".expected.redress"));

            _send(v);
            RedressVault.Record memory r = vault.recordOf(v.liquidationTx, 0);
            assertEq(r.verdict, v.verdict, json.readString(string.concat(p, ".name")));
            assertEq(r.paid, v.redress > 0, json.readString(string.concat(p, ".name")));
            total += v.redress;
            if (v.redress > 0) paying++;
        }
        assertGt(paying, 0);
        assertEq(vault.totalPaid(), total);
        assertEq(weth.balanceOf(VICTIM), total);
    }

    /// Reports encoded by report.ts from real incident rows, accepted at the exact wei.
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

    /// The incident against a reserve too small for its largest event: the 20% cap holds.
    function test_incidentAgainstASmallReserveQueuesAndNeverOverspends() public {
        RedressVault capped = _deploy(2_000, bytes32(0), address(0));
        _fund(capped, 1_000 ether);
        string memory json = vm.readFile("test/report-fixture.json");
        uint256 count = json.readUint(".count");
        for (uint256 i = 0; i < count; i++) {
            vm.prank(FORWARDER);
            capped.onReport("", json.readBytes(string.concat(".reports[", vm.toString(i), "].report")));
        }
        assertLe(capped.totalPaid(), 200 ether);
        assertGt(capped.totalPaid(), 0);
    }
}
