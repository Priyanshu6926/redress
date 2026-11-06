// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library VerdictMath {
    uint8 public constant VERDICT_VALID = 0;
    uint8 public constant VERDICT_WRONGFUL = 1;
    uint8 public constant VERDICT_EXCESS = 2;
    uint8 public constant VERDICT_AMBIGUOUS = 3;
    uint8 public constant VERDICT_INCONCLUSIVE = 4;

    uint256 internal constant WAD = 1e18;

    /**
     * @notice Re-derives the redress floor on-chain from verdict fields.
     * @param verdict Verdict enum code (0: VALID, 1: WRONGFUL, 2: EXCESS, 3: AMBIGUOUS, 4: INCONCLUSIVE)
     * @param collateralSeized Amount of collateral seized (C)
     * @param debtToCover Amount of debt covered (X)
     * @param bandLowE18 Independent collateral price lower bound (p_c^L in 1e18)
     * @param debtPriceHighE18 Debt price upper bound (p_d^H in 1e18)
     * @param liquidationBonusBps Liquidation bonus in basis points (e.g. 100 for 1%)
     */
    function computeRedress(
        uint8 verdict,
        uint256 collateralSeized,
        uint256 debtToCover,
        uint256 bandLowE18,
        uint256 debtPriceHighE18,
        uint256 liquidationBonusBps
    ) internal pure returns (uint256) {
        if (verdict == VERDICT_VALID || verdict == VERDICT_INCONCLUSIVE) {
            return 0;
        }

        // Value of seized collateral at conservative low price
        uint256 collateralValueLow = (collateralSeized * bandLowE18) / WAD;

        if (verdict == VERDICT_WRONGFUL) {
            // WRONGFUL: max(0, C * p_c^L - X * p_d^H)
            uint256 debtValueHigh = (debtToCover * debtPriceHighE18) / WAD;
            if (collateralValueLow > debtValueHigh) {
                return collateralValueLow - debtValueHigh;
            }
            return 0;
        }

        if (verdict == VERDICT_EXCESS || verdict == VERDICT_AMBIGUOUS) {
            // Entitlement = X * p_d^H * (1 + b)
            uint256 debtValueHigh = (debtToCover * debtPriceHighE18) / WAD;
            uint256 entitlement = (debtValueHigh * (10_000 + liquidationBonusBps)) / 10_000;
            if (collateralValueLow > entitlement) {
                return collateralValueLow - entitlement;
            }
            return 0;
        }

        return 0;
    }
}

