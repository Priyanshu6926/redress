// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VerdictMath as VM} from "../../src/VerdictMath.sol";

/// External entry points so reverts can be asserted.
contract Harness {
    function hfFloor(uint256 a, uint256 pc, uint256 d, uint256 pd, uint256 lt) external pure returns (uint256) {
        return VM.hfFloor(a, pc, d, pd, lt);
    }

    function computeRedress(uint8 v, uint256 c, uint256 x, uint256 low, uint256 high, uint256 bonus)
        external
        pure
        returns (uint256)
    {
        return VM.computeRedress(v, c, x, low, high, bonus);
    }

    function gate(uint256 oc, uint256 od, uint256 low, uint256 high, uint256 tau) external pure returns (bool) {
        return VM.gate(oc, od, low, high, tau);
    }

    function buildBand(uint256[] memory p, uint256[] memory t) external pure returns (VM.Band memory) {
        VM.Config memory cfg;
        return VM.buildBand(p, t, 0, cfg);
    }
}

contract VerdictMathTest is Test {
    using stdJson for string;

    uint256 private constant WORDS = 39;
    Harness private harness = new Harness();

    struct Inputs {
        uint256[] prices;
        uint256[] stamps;
        uint256 asOf;
        VM.Config cfg;
        VM.Position base;
        uint256 earlierC;
        uint256 earlierX;
        VM.Liquidation liquidation;
        uint256 debtLow;
        uint256 debtHigh;
    }

    struct Expected {
        uint256 bandOk;
        uint256 low;
        uint256 high;
        uint256 n;
        uint256 confidence;
        uint256 gateOpen;
        uint256 verdict;
        uint256 hfBest;
        uint256 hfWorst;
        uint256 redress;
    }

    function _check(Inputs memory k, Expected memory e, string memory label) private pure {
        VM.Band memory band = VM.buildBand(k.prices, k.stamps, k.asOf, k.cfg);
        assertEq(band.ok ? 1 : 0, e.bandOk, label);
        assertEq(band.low, e.low, label);
        assertEq(band.high, e.high, label);
        assertEq(band.n, e.n, label);
        assertEq(band.confidence, e.confidence, label);

        VM.Position memory position = VM.rebuild(k.base, k.earlierC, k.earlierX);
        VM.Outcome memory outcome = VM.verdict(position, k.liquidation, band, k.debtLow, k.debtHigh, k.cfg);
        assertEq(outcome.verdict, e.verdict, label);
        assertEq(outcome.hfBest, e.hfBest, label);
        assertEq(outcome.hfWorst, e.hfWorst, label);
        assertEq(VM.redress(position, k.liquidation, band, k.debtHigh, outcome.verdict), e.redress, label);

        bool open = band.ok
            && VM.gate(
                k.liquidation.oracleCollateralPrice, k.liquidation.oracleDebtPrice, band.low, k.debtHigh, k.cfg.tauBps
            );
        assertEq(open ? 1 : 0, e.gateOpen, label);
    }

    function _sum(uint256[] memory values) private pure returns (uint256 total) {
        for (uint256 i = 0; i < values.length; i++) {
            total += values[i];
        }
    }

    function _u(string memory json, string memory p, string memory key) private pure returns (uint256) {
        return json.readUint(string.concat(p, key));
    }

    function _jsonInputs(string memory json, string memory p) private pure returns (Inputs memory k) {
        k.prices = json.readUintArray(string.concat(p, ".sourcePrices"));
        k.stamps = json.readUintArray(string.concat(p, ".sourceTimestamps"));
        k.asOf = _u(json, p, ".asOf");
        k.cfg = VM.Config({
            tauBps: _u(json, p, ".tauBps"),
            muBps: _u(json, p, ".muBps"),
            epsOutBps: _u(json, p, ".epsOutBps"),
            epsHBps: _u(json, p, ".epsHBps"),
            minSources: _u(json, p, ".minSources"),
            maxStalenessSec: _u(json, p, ".maxStalenessSec")
        });
        k.base = VM.Position({
            collateral: _u(json, p, ".A"),
            debt: _u(json, p, ".D"),
            ltBps: _u(json, p, ".ltBps"),
            bonusBps: _u(json, p, ".bonusBps")
        });
        k.earlierC = _sum(json.readUintArray(string.concat(p, ".earlierC")));
        k.earlierX = _sum(json.readUintArray(string.concat(p, ".earlierX")));
        k.liquidation = VM.Liquidation({
            collateralSeized: _u(json, p, ".C"),
            debtCovered: _u(json, p, ".X"),
            oracleCollateralPrice: _u(json, p, ".oracleCollateral"),
            oracleDebtPrice: _u(json, p, ".oracleDebt")
        });
        k.debtLow = _u(json, p, ".debtLow");
        k.debtHigh = _u(json, p, ".debtHigh");
    }

    function _jsonExpected(string memory json, string memory p) private pure returns (Expected memory e) {
        string memory x = string.concat(p, ".expected");
        e.bandOk = _u(json, x, ".bandOk");
        e.low = _u(json, x, ".low");
        e.high = _u(json, x, ".high");
        e.n = _u(json, x, ".n");
        e.confidence = _u(json, x, ".confidence");
        e.gateOpen = _u(json, x, ".gate");
        e.verdict = _u(json, x, ".verdict");
        e.hfBest = _u(json, x, ".hfBest");
        e.hfWorst = _u(json, x, ".hfWorst");
        e.redress = _u(json, x, ".redress");
    }

    function test_sharedVectors() public view {
        string memory json = vm.readFile("test/vectors.json");
        uint256 count = json.readUint(".count");
        assertGt(count, 0);
        for (uint256 i = 0; i < count; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            _check(_jsonInputs(json, p), _jsonExpected(json, p), json.readString(string.concat(p, ".name")));
        }
    }

    function _w(bytes memory data, uint256 index) private pure returns (uint256 value) {
        assembly {
            value := mload(add(add(data, 32), mul(index, 32)))
        }
    }

    function _binInputs(bytes memory d, uint256 b) private pure returns (Inputs memory k) {
        k.prices = new uint256[](5);
        k.stamps = new uint256[](5);
        for (uint256 j = 0; j < 5; j++) {
            k.prices[j] = _w(d, b + 7 + j);
            k.stamps[j] = _w(d, b + 12 + j);
        }
        k.asOf = _w(d, b);
        k.cfg = VM.Config({
            tauBps: _w(d, b + 1),
            muBps: _w(d, b + 2),
            epsOutBps: _w(d, b + 3),
            epsHBps: _w(d, b + 4),
            minSources: _w(d, b + 5),
            maxStalenessSec: _w(d, b + 6)
        });
        k.debtLow = _w(d, b + 17);
        k.debtHigh = _w(d, b + 18);
        k.base = VM.Position({collateral: _w(d, b + 19), debt: _w(d, b + 20), ltBps: _w(d, b + 21), bonusBps: _w(d, b + 22)});
        k.liquidation = VM.Liquidation({
            collateralSeized: _w(d, b + 23),
            debtCovered: _w(d, b + 24),
            oracleCollateralPrice: _w(d, b + 25),
            oracleDebtPrice: _w(d, b + 26)
        });
        k.earlierC = _w(d, b + 27);
        k.earlierX = _w(d, b + 28);
    }

    function _binExpected(bytes memory d, uint256 b) private pure returns (Expected memory e) {
        e.bandOk = _w(d, b + 29);
        e.low = _w(d, b + 30);
        e.high = _w(d, b + 31);
        e.n = _w(d, b + 32);
        e.confidence = _w(d, b + 33);
        e.gateOpen = _w(d, b + 34);
        e.verdict = _w(d, b + 35);
        e.hfBest = _w(d, b + 36);
        e.hfWorst = _w(d, b + 37);
        e.redress = _w(d, b + 38);
    }

    /// 10,000 random cases computed by verdict.ts. Generate with `bun run vectors:random`.
    function test_matchesTypeScriptOnRandomVectors() public view {
        bytes memory data = vm.readFileBinary("test/vectors-random.bin");
        uint256 count = _w(data, 0);
        assertGe(count, 10_000);
        assertEq(data.length, (1 + count * WORDS) * 32);
        for (uint256 i = 0; i < count; i++) {
            uint256 base = 1 + i * WORDS;
            _check(_binInputs(data, base), _binExpected(data, base), vm.toString(i));
        }
    }

    function test_boundsRevert() public {
        vm.expectRevert(abi.encodeWithSelector(VM.AmountOutOfBounds.selector, uint256(1e30 + 1)));
        harness.hfFloor(1e30 + 1, 1, 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(VM.PriceOutOfBounds.selector, uint256(1e24 + 1)));
        harness.hfFloor(1, 1e24 + 1, 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(VM.BpsOutOfBounds.selector, uint256(10_001)));
        harness.hfFloor(1, 1, 1, 1, 10_001);
        vm.expectRevert(abi.encodeWithSelector(VM.BpsOutOfBounds.selector, uint256(10_001)));
        harness.computeRedress(1, 1, 1, 1, 1, 10_001);
        vm.expectRevert(abi.encodeWithSelector(VM.BpsOutOfBounds.selector, uint256(10_001)));
        harness.gate(1, 1, 1, 1, 10_001);
    }

    function test_lengthMismatchReverts() public {
        vm.expectRevert(VM.LengthMismatch.selector);
        harness.buildBand(new uint256[](1), new uint256[](2));
    }

    function test_nonPayingCodesSkipBoundsChecks() public view {
        assertEq(harness.computeRedress(0, 1e31, 1, 1, 1, 0), 0);
        assertEq(harness.computeRedress(9, 1, 1, 1, 1, 0), 0);
    }
}
