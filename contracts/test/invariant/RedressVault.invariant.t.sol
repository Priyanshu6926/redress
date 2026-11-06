// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {RedressVault, Verdict} from "../../src/RedressVault.sol";
import {VerdictMath} from "../../src/VerdictMath.sol";
import {MockWETH} from "../mocks/MockWETH.sol";

/// Drives the vault with reports, duplicates, bad reports, funding, time, pause and settle,
/// keeping its own ledger to compare against the vault.
contract VaultHandler is Test {
    address internal constant FORWARDER = address(0xF0);
    uint256 internal constant EPOCH = 1 days;

    RedressVault public vault;
    MockWETH public weth;

    struct Entry {
        bytes32 tx_;
        uint32 logIndex;
        address user;
        uint8 verdict;
        uint256 redress;
        uint256 collateralCap;
    }

    Entry[] public entries;
    mapping(address user => uint256 owed) public paidTo;
    address[] public users;

    uint256 public ghostFunded;
    uint256 public reportsAccepted;
    uint256 public duplicatesRejected;
    uint256 public mismatchesRejected;
    uint256 public settled;
    /// Counted, not reverted: Foundry discards handler reverts unless fail_on_revert is set.
    uint256 public wrongAccepted;
    uint256 private nonce;

    constructor(RedressVault vault_, MockWETH weth_) {
        vault = vault_;
        weth = weth_;
        for (uint160 i = 1; i <= 5; i++) {
            users.push(address(0x1000 + i));
        }
    }

    function entryCount() external view returns (uint256) {
        return entries.length;
    }

    function userCount() external view returns (uint256) {
        return users.length;
    }

    function _build(uint256 seed, uint8 code, uint256 c, uint256 x, uint256 low, uint256 bonus)
        private
        returns (Verdict memory v)
    {
        v.liquidationTx = keccak256(abi.encode(nonce++));
        v.logIndex = uint32(seed % 4);
        v.user = users[seed % users.length];
        v.verdict = uint8(bound(code, 0, 6));
        v.collateralSeized = bound(c, 0, 100e18);
        v.debtToCover = bound(x, 0, 100e18);
        v.bandLowE18 = bound(low, 1e18, 1.3e18);
        v.bandHighE18 = v.bandLowE18;
        v.debtPriceHighE18 = 1e18;
        v.liquidationBonusBps = bound(bonus, 0, 2_000);
        v.redress = VerdictMath.computeRedress(
            v.verdict, v.collateralSeized, v.debtToCover, v.bandLowE18, v.debtPriceHighE18, v.liquidationBonusBps
        );
    }

    function report(uint256 seed, uint8 code, uint256 c, uint256 x, uint256 low, uint256 bonus) external {
        Verdict memory v = _build(seed, code, c, x, low, bonus);
        vm.prank(FORWARDER);
        vault.onReport("", abi.encode(v));
        entries.push(
            Entry(v.liquidationTx, v.logIndex, v.user, v.verdict, v.redress, v.collateralSeized * v.bandLowE18 / 1e18)
        );
        reportsAccepted++;
    }

    function badRedress(uint256 seed, uint8 code, uint256 c, uint256 x, uint256 low, uint256 bonus) external {
        Verdict memory v = _build(seed, code, c, x, low, bonus);
        v.redress += 1;
        vm.prank(FORWARDER);
        try vault.onReport("", abi.encode(v)) {
            wrongAccepted++;
        } catch {
            mismatchesRejected++;
        }
    }

    function duplicate(uint256 index) external {
        if (entries.length == 0) return;
        Entry memory e = entries[index % entries.length];
        Verdict memory v;
        v.liquidationTx = e.tx_;
        v.logIndex = e.logIndex;
        v.user = e.user;
        vm.prank(FORWARDER);
        try vault.onReport("", abi.encode(v)) {
            wrongAccepted++;
        } catch {
            duplicatesRejected++;
        }
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0, 500e18);
        weth.mint(address(this), amount);
        weth.approve(address(vault), amount);
        vault.fund(amount);
        ghostFunded += amount;
    }

    function donate(uint256 amount) external {
        weth.mint(address(vault), bound(amount, 0, 500e18));
    }

    function settle(uint256 index) external {
        if (entries.length == 0) return;
        Entry memory e = entries[index % entries.length];
        try vault.settle(e.tx_, e.logIndex) {
            settled++;
        } catch {}
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1, 3 days));
    }

    function togglePause(bool value) external {
        vm.prank(vault.owner());
        vault.setPaused(value);
    }
}

contract RedressVaultInvariantTest is Test {
    RedressVault private vault;
    MockWETH private weth;
    VaultHandler private handler;

    function setUp() public {
        vm.warp(1_000 days);
        weth = new MockWETH();
        vault = new RedressVault(
            RedressVault.Config({
                forwarder: address(0xF0),
                payoutAsset: address(weth),
                maxLiquidationBonusBps: 2_000,
                epochCapBps: 2_000,
                epochLength: 1 days,
                expectedWorkflowId: bytes32(0),
                expectedWorkflowOwner: address(0)
            })
        );
        handler = new VaultHandler(vault, weth);
        // The handler toggles pause through the vault owner, which is this contract.
        targetContract(address(handler));
    }

    function invariant_totalPaidNeverExceedsFunded() public view {
        assertLe(vault.totalPaid(), vault.totalFunded());
        assertEq(vault.totalFunded(), handler.ghostFunded());
    }

    function invariant_vaultHoldsAtLeastItsReserve() public view {
        assertGe(weth.balanceOf(address(vault)), vault.available());
    }

    function invariant_tokensLeftOnlyAsRecordedPayouts() public view {
        uint256 received;
        for (uint256 i = 0; i < handler.userCount(); i++) {
            received += weth.balanceOf(handler.users(i));
        }
        assertEq(received, vault.totalPaid());
    }

    function invariant_everyEntryIsPaidAtMostOnceAndOnlyIfItPays() public view {
        uint256 paidSum;
        uint256 n = handler.entryCount();
        for (uint256 i = 0; i < n; i++) {
            (bytes32 tx_, uint32 logIndex,, uint8 verdict, uint256 redress, uint256 cap) = handler.entries(i);
            RedressVault.Record memory r = vault.recordOf(tx_, logIndex);
            assertTrue(r.attested);
            assertEq(r.verdict, verdict);
            assertEq(r.redress, redress);
            assertLe(redress, cap);
            if (verdict != 1 && verdict != 2 && verdict != 3) {
                assertEq(redress, 0);
                assertFalse(r.paid);
            }
            if (r.paid) paidSum += r.redress;
        }
        // Equality means no entry was paid twice and nothing was paid outside an entry.
        assertEq(paidSum, vault.totalPaid());
    }

    function invariant_duplicatesAndMismatchesAreNeverAccepted() public view {
        assertEq(handler.wrongAccepted(), 0);
    }

    function invariant_epochCapHolds() public view {
        assertLe(vault.epochSpent(), vault.epochBudget());
    }

    function afterInvariant() external view {
        // Guards against a run that never reaches the interesting paths.
        assertGt(handler.reportsAccepted() + handler.mismatchesRejected() + handler.settled(), 0);
    }
}
