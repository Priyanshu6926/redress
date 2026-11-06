// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VerdictMath as VM} from "../../src/VerdictMath.sol";

contract VerdictMathFuzzTest is Test {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct Case {
        uint256 a;
        uint256 d;
        uint256 c;
        uint256 x;
        uint256 lt;
        uint256 bonus;
        uint256 low;
        uint256 high;
        uint256 debtLow;
        uint256 debtHigh;
        uint256 oc;
        uint256 od;
    }

    function _cfg() private pure returns (VM.Config memory) {
        return VM.Config({tauBps: 75, muBps: 10, epsOutBps: 100, epsHBps: 10, minSources: 3, maxStalenessSec: 3600});
    }

    /// Keeps most inputs near realistic values so every verdict branch is reached.
    function _shape(Case memory k) private pure returns (Case memory) {
        k.a = bound(k.a, 0, 1e30);
        k.d = bound(k.d, 0, 1e30);
        k.c = bound(k.c, 0, 1e30);
        k.x = bound(k.x, 0, 1e30);
        k.lt = bound(k.lt, 5000, BPS);
        k.bonus = bound(k.bonus, 0, 1000);
        k.low = bound(k.low, 1, 1e24);
        k.high = bound(k.high, k.low, 1e24);
        k.debtLow = bound(k.debtLow, 1, 1e24);
        k.debtHigh = bound(k.debtHigh, k.debtLow, 1e24);
        k.oc = bound(k.oc, 0, 1e24);
        k.od = bound(k.od, 0, 1e24);
        return k;
    }

    function _near(Case memory k) private pure returns (Case memory) {
        k.a = bound(k.a, 1e18, 1e24);
        k.lt = bound(k.lt, 9000, 9700);
        k.bonus = bound(k.bonus, 0, 600);
        k.low = bound(k.low, 1.1e18, 1.3e18);
        k.high = bound(k.high, k.low, k.low + k.low / 100);
        k.debtLow = 1e18;
        k.debtHigh = 1e18;
        // Debt within about 10% of the threshold, so HF lands near 1.
        k.d = bound(k.d, k.a * k.low / WAD * k.lt / BPS * 9 / 10, k.a * k.low / WAD * k.lt / BPS * 11 / 10 + 1);
        k.x = bound(k.x, 0, k.d);
        k.oc = bound(k.oc, k.low * 90 / 100, k.high * 110 / 100);
        k.c = bound(k.c, 0, k.x * 2 + 1);
        k.od = 1e18;
        return k;
    }

    function _band(Case memory k) private pure returns (VM.Band memory) {
        return VM.Band({ok: true, low: k.low, high: k.high, n: 3, confidence: BPS});
    }

    function _position(Case memory k) private pure returns (VM.Position memory) {
        return VM.Position({collateral: k.a, debt: k.d, ltBps: k.lt, bonusBps: k.bonus});
    }

    function _liquidation(Case memory k) private pure returns (VM.Liquidation memory) {
        return VM.Liquidation({collateralSeized: k.c, debtCovered: k.x, oracleCollateralPrice: k.oc, oracleDebtPrice: k.od});
    }

    function _run(Case memory k) private pure returns (VM.Outcome memory o, uint256 pay) {
        o = VM.verdict(_position(k), _liquidation(k), _band(k), k.debtLow, k.debtHigh, _cfg());
        pay = VM.redress(_position(k), _liquidation(k), _band(k), k.debtHigh, o.verdict);
    }

    // Reference: same specification written with explicit remainders and no shared helpers.

    function _ceil(uint256 n, uint256 d) private pure returns (uint256) {
        return n % d == 0 ? n / d : n / d + 1;
    }

    function _refWorst(Case memory k) private pure returns (uint256) {
        if (k.d == 0) return type(uint256).max;
        uint256 adjusted = (k.a * k.low / WAD) * k.lt / BPS;
        return adjusted * WAD / _ceil(k.d * k.debtHigh, WAD);
    }

    function _refBest(Case memory k) private pure returns (uint256) {
        uint256 debt = k.d * k.debtLow / WAD;
        if (debt == 0) return type(uint256).max;
        return _ceil(_ceil(_ceil(k.a * k.high, WAD) * k.lt, BPS) * WAD, debt);
    }

    function _refExcess(Case memory k) private pure returns (uint256) {
        uint256 value = k.c * k.low / WAD;
        uint256 entitlement = _ceil(_ceil(k.x * k.debtHigh, WAD) * (BPS + k.bonus), BPS);
        return value > entitlement ? value - entitlement : 0;
    }

    function _reference(Case memory k) private pure returns (uint8 v, uint256 pay) {
        bool open = k.oc * BPS < k.low * (BPS - 75) || k.od * BPS > k.debtHigh * (BPS + 75);
        if (!open) return (k.oc > k.high ? 5 : 0, 0);
        if (_refWorst(k) >= 1.001e18) {
            uint256 value = k.c * k.low / WAD;
            uint256 debt = _ceil(k.x * k.debtHigh, WAD);
            return (1, value > debt ? value - debt : 0);
        }
        uint256 excess = _refExcess(k);
        if (_refBest(k) < WAD) return excess > 0 ? (2, excess) : (0, 0);
        return (3, excess);
    }

    function _assertMatchesReference(Case memory k) private pure {
        (VM.Outcome memory o, uint256 pay) = _run(k);
        (uint8 refVerdict, uint256 refPay) = _reference(k);
        assertEq(o.verdict, refVerdict);
        assertEq(pay, refPay);
        assertEq(o.hfWorst, _refWorst(k));
        assertEq(o.hfBest, _refBest(k));
    }

    function testFuzz_matchesReference(Case memory k) public pure {
        _assertMatchesReference(_shape(k));
    }

    function testFuzz_matchesReferenceNearThreshold(Case memory k) public pure {
        _assertMatchesReference(_near(k));
    }

    function _assertRedressBounds(Case memory k) private pure {
        (VM.Outcome memory o, uint256 pay) = _run(k);

        if (o.verdict == 0 || o.verdict == 4 || o.verdict == 5) assertEq(pay, 0);
        if (pay > 0) {
            // Exact real-number bound: pay <= C * low - X * debtHigh.
            assertLe(pay * WAD + k.x * k.debtHigh, k.c * k.low);
            assertLe(pay, k.c * k.low / WAD);
        }
    }

    function testFuzz_redressNeverExceedsProvableLoss(Case memory k) public pure {
        _assertRedressBounds(_shape(k));
    }

    function testFuzz_redressNeverExceedsProvableLossNearThreshold(Case memory k) public pure {
        _assertRedressBounds(_near(k));
    }

    function testFuzz_inconclusivePaysNothing(Case memory k) public pure {
        k = _shape(k);
        VM.Band memory band;
        VM.Outcome memory o = VM.verdict(_position(k), _liquidation(k), band, k.debtLow, k.debtHigh, _cfg());
        assertEq(o.verdict, VM.VERDICT_INCONCLUSIVE);
        assertEq(VM.redress(_position(k), _liquidation(k), band, k.debtHigh, 1), 0);
    }

    function _assertWiderNeverPaysMore(Case memory k, uint256 lowCut, uint256 highAdd, uint256 debtAdd) private pure {
        (, uint256 inner) = _run(k);

        Case memory wide = k;
        wide.low = k.low - bound(lowCut, 0, k.low - 1);
        wide.high = k.high + bound(highAdd, 0, 1e24 - k.high);
        wide.debtLow = k.debtLow - bound(debtAdd, 0, k.debtLow - 1);
        wide.debtHigh = k.debtHigh + bound(debtAdd, 0, 1e24 - k.debtHigh);
        (, uint256 outer) = _run(wide);

        assertLe(outer, inner);
    }

    function testFuzz_widerBandNeverIncreasesRedress(Case memory k, uint256 lowCut, uint256 highAdd, uint256 debtAdd)
        public
        pure
    {
        _assertWiderNeverPaysMore(_shape(k), lowCut, highAdd, debtAdd);
    }

    function testFuzz_widerBandNeverIncreasesRedressNearThreshold(
        Case memory k,
        uint256 lowCut,
        uint256 highAdd,
        uint256 debtAdd
    ) public pure {
        k = _near(k);
        _assertWiderNeverPaysMore(k, bound(lowCut, 0, k.low / 50), bound(highAdd, 0, k.high / 50), 0);
    }

    function testFuzz_rebuildNeverIncreasesBalances(uint256 a, uint256 d, uint256 c, uint256 x) public pure {
        VM.Position memory p = VM.rebuild(VM.Position({collateral: a, debt: d, ltBps: 9500, bonusBps: 100}), c, x);
        assertLe(p.collateral, a);
        assertLe(p.debt, d);
    }

    function testFuzz_bandBoundsContainSurvivors(uint256 p0, uint256 p1, uint256 p2) public pure {
        uint256[] memory prices = new uint256[](3);
        prices[0] = bound(p0, 1e18, 1.01e18);
        prices[1] = bound(p1, 1e18, 1.01e18);
        prices[2] = bound(p2, 1e18, 1.01e18);
        VM.Band memory band = VM.buildBand(prices, new uint256[](3), 0, _cfg());
        if (!band.ok) return;
        for (uint256 i = 0; i < 3; i++) {
            assertLe(band.low, prices[i]);
            assertGe(band.high, prices[i]);
        }
    }
}
