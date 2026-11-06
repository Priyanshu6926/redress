// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Verdict engine. docs/VERDICT_SPEC.md is the definition, and
/// cre/sentinel-verdict/verdict.ts must match this library bit for bit.
library VerdictMath {
    uint8 public constant VERDICT_VALID = 0;
    uint8 public constant VERDICT_WRONGFUL = 1;
    uint8 public constant VERDICT_EXCESS = 2;
    uint8 public constant VERDICT_AMBIGUOUS = 3;
    uint8 public constant VERDICT_INCONCLUSIVE = 4;
    uint8 public constant VERDICT_OVERPRICED = 5;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant HF_MAX = type(uint256).max;
    uint256 internal constant MAX_AMOUNT = 1e30;
    uint256 internal constant MAX_PRICE = 1e24;

    error AmountOutOfBounds(uint256 value);
    error PriceOutOfBounds(uint256 value);
    error BpsOutOfBounds(uint256 value);
    error LengthMismatch();

    struct Config {
        uint256 tauBps;
        uint256 muBps;
        uint256 epsOutBps;
        uint256 epsHBps;
        uint256 minSources;
        uint256 maxStalenessSec;
    }

    struct Band {
        bool ok; // false means INCONCLUSIVE
        uint256 low;
        uint256 high;
        uint256 n;
        uint256 confidence;
    }

    struct Position {
        uint256 collateral; // A
        uint256 debt; // D
        uint256 ltBps;
        uint256 bonusBps;
    }

    struct Liquidation {
        uint256 collateralSeized; // C, gross of the protocol fee
        uint256 debtCovered; // X
        uint256 oracleCollateralPrice;
        uint256 oracleDebtPrice;
    }

    struct Outcome {
        uint8 verdict;
        uint256 hfBest;
        uint256 hfWorst;
    }

    function buildBand(uint256[] memory prices, uint256[] memory timestamps, uint256 asOf, Config memory cfg)
        internal
        pure
        returns (Band memory band)
    {
        if (prices.length != timestamps.length) revert LengthMismatch();
        _checkBps(cfg.muBps);
        _checkBps(cfg.epsOutBps);

        (uint256[] memory usable, uint256 count) = _usableSorted(prices, timestamps, asOf, cfg.maxStalenessSec);
        if (count == 0) return band;

        uint256 mid = count / 2;
        uint256 m = count % 2 == 1 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;

        (uint256 survivors, uint256 lowest, uint256 highest) = _survivors(usable, count, m, cfg.epsOutBps);
        if (survivors == 0 || survivors < cfg.minSources) return band;

        band.ok = true;
        band.low = _mulDivDown(lowest, BPS - cfg.muBps, BPS);
        band.high = _mulDivUp(highest, BPS + cfg.muBps, BPS);
        band.n = survivors;
        band.confidence = _mulDivDown(survivors, BPS, prices.length);
    }

    function _usableSorted(uint256[] memory prices, uint256[] memory timestamps, uint256 asOf, uint256 maxStaleness)
        private
        pure
        returns (uint256[] memory usable, uint256 count)
    {
        usable = new uint256[](prices.length);
        for (uint256 i = 0; i < prices.length; i++) {
            _checkPrice(prices[i]);
            uint256 age = asOf > timestamps[i] ? asOf - timestamps[i] : timestamps[i] - asOf;
            if (prices[i] == 0 || age > maxStaleness) continue;

            uint256 j = count++;
            while (j > 0 && usable[j - 1] > prices[i]) {
                usable[j] = usable[j - 1];
                j--;
            }
            usable[j] = prices[i];
        }
    }

    function _survivors(uint256[] memory usable, uint256 count, uint256 m, uint256 epsOutBps)
        private
        pure
        returns (uint256 survivors, uint256 lowest, uint256 highest)
    {
        for (uint256 i = 0; i < count; i++) {
            uint256 distance = usable[i] > m ? usable[i] - m : m - usable[i];
            if (distance * BPS > epsOutBps * m) continue;
            if (survivors == 0) lowest = usable[i];
            highest = usable[i];
            survivors++;
        }
    }

    function gate(
        uint256 oracleCollateralPrice,
        uint256 oracleDebtPrice,
        uint256 collateralLow,
        uint256 debtHigh,
        uint256 tauBps
    ) internal pure returns (bool) {
        _checkPrice(oracleCollateralPrice);
        _checkPrice(oracleDebtPrice);
        _checkBps(tauBps);
        return oracleCollateralPrice * BPS < collateralLow * (BPS - tauBps)
            || oracleDebtPrice * BPS > debtHigh * (BPS + tauBps);
    }

    /// @notice Lowest provable health factor: every rounding step goes down.
    function hfFloor(uint256 a, uint256 pc, uint256 d, uint256 pd, uint256 ltBps) internal pure returns (uint256) {
        _checkHfInputs(a, pc, d, pd, ltBps);
        if (d == 0 || pd == 0) return HF_MAX;
        uint256 adjusted = _mulDivDown(_mulDivDown(a, pc, WAD), ltBps, BPS);
        return _mulDivDown(adjusted, WAD, _mulDivUp(d, pd, WAD));
    }

    /// @notice Highest provable health factor: every rounding step goes up.
    function hfCeil(uint256 a, uint256 pc, uint256 d, uint256 pd, uint256 ltBps) internal pure returns (uint256) {
        _checkHfInputs(a, pc, d, pd, ltBps);
        uint256 debtValue = _mulDivDown(d, pd, WAD);
        if (debtValue == 0) return HF_MAX;
        uint256 adjusted = _mulDivUp(_mulDivUp(a, pc, WAD), ltBps, BPS);
        return _mulDivUp(adjusted, WAD, debtValue);
    }

    function verdict(
        Position memory position,
        Liquidation memory liquidation,
        Band memory collateralBand,
        uint256 debtLow,
        uint256 debtHigh,
        Config memory cfg
    ) internal pure returns (Outcome memory outcome) {
        if (!collateralBand.ok) {
            outcome.verdict = VERDICT_INCONCLUSIVE;
            return outcome;
        }

        outcome.hfWorst = hfFloor(position.collateral, collateralBand.low, position.debt, debtHigh, position.ltBps);
        outcome.hfBest = hfCeil(position.collateral, collateralBand.high, position.debt, debtLow, position.ltBps);

        if (!gate(
                liquidation.oracleCollateralPrice, liquidation.oracleDebtPrice, collateralBand.low, debtHigh, cfg.tauBps
            )) {
            outcome.verdict =
                liquidation.oracleCollateralPrice > collateralBand.high ? VERDICT_OVERPRICED : VERDICT_VALID;
            return outcome;
        }

        _checkBps(cfg.epsHBps);
        if (outcome.hfWorst >= _mulDivUp(WAD, BPS + cfg.epsHBps, BPS)) {
            outcome.verdict = VERDICT_WRONGFUL;
        } else if (outcome.hfBest < WAD) {
            uint256 excess = computeRedress(
                VERDICT_EXCESS,
                liquidation.collateralSeized,
                liquidation.debtCovered,
                collateralBand.low,
                debtHigh,
                position.bonusBps
            );
            outcome.verdict = excess > 0 ? VERDICT_EXCESS : VERDICT_VALID;
        } else {
            outcome.verdict = VERDICT_AMBIGUOUS;
        }
    }

    function redress(
        Position memory position,
        Liquidation memory liquidation,
        Band memory collateralBand,
        uint256 debtHigh,
        uint8 v
    ) internal pure returns (uint256) {
        if (!collateralBand.ok) return 0;
        return computeRedress(
            v, liquidation.collateralSeized, liquidation.debtCovered, collateralBand.low, debtHigh, position.bonusBps
        );
    }

    /// @notice Re-derives redress from flat report fields.
    function computeRedress(
        uint8 v,
        uint256 collateralSeized,
        uint256 debtToCover,
        uint256 bandLowE18,
        uint256 debtPriceHighE18,
        uint256 liquidationBonusBps
    ) internal pure returns (uint256) {
        if (v != VERDICT_WRONGFUL && v != VERDICT_EXCESS && v != VERDICT_AMBIGUOUS) return 0;

        _checkAmount(collateralSeized);
        _checkAmount(debtToCover);
        _checkPrice(bandLowE18);
        _checkPrice(debtPriceHighE18);
        _checkBps(liquidationBonusBps);

        uint256 collateralFloor = _mulDivDown(collateralSeized, bandLowE18, WAD);
        uint256 debtCeil = _mulDivUp(debtToCover, debtPriceHighE18, WAD);
        uint256 owed = v == VERDICT_WRONGFUL ? debtCeil : _mulDivUp(debtCeil, BPS + liquidationBonusBps, BPS);
        return collateralFloor > owed ? collateralFloor - owed : 0;
    }

    /// @notice Position before a liquidation, from balances at block - 1 and the
    /// sums of earlier liquidations of the same market and user in the same block.
    function rebuild(Position memory base, uint256 earlierCollateral, uint256 earlierDebt)
        internal
        pure
        returns (Position memory)
    {
        return Position({
            collateral: base.collateral > earlierCollateral ? base.collateral - earlierCollateral : 0,
            debt: base.debt > earlierDebt ? base.debt - earlierDebt : 0,
            ltBps: base.ltBps,
            bonusBps: base.bonusBps
        });
    }

    function _mulDivDown(uint256 a, uint256 b, uint256 c) private pure returns (uint256) {
        return a * b / c;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 c) private pure returns (uint256) {
        return (a * b + c - 1) / c;
    }

    function _checkHfInputs(uint256 a, uint256 pc, uint256 d, uint256 pd, uint256 ltBps) private pure {
        _checkAmount(a);
        _checkAmount(d);
        _checkPrice(pc);
        _checkPrice(pd);
        _checkBps(ltBps);
    }

    function _checkAmount(uint256 value) private pure {
        if (value > MAX_AMOUNT) revert AmountOutOfBounds(value);
    }

    function _checkPrice(uint256 value) private pure {
        if (value > MAX_PRICE) revert PriceOutOfBounds(value);
    }

    function _checkBps(uint256 value) private pure {
        if (value > BPS) revert BpsOutOfBounds(value);
    }
}
