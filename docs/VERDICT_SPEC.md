# Verdict engine specification

This is the normative definition of the Redress verdict engine. `cre/sentinel-verdict/verdict.ts` and `contracts/src/VerdictMath.sol` both implement it and must agree bit for bit. `contracts/test/vectors.json` is the shared test file. The design rationale is in PRD section 6.

## 1. Units

| Quantity | Type | Unit |
|---|---|---|
| Prices | unsigned integer | 1e18 fixed point, numeraire per whole token |
| Amounts `A`, `D`, `C`, `X` | unsigned integer | token base units; 18-decimal assets only |
| Health factors | unsigned integer | 1e18 fixed point |
| `LT`, bonus, tolerances, confidence | unsigned integer | basis points (10,000 = 100%) |
| Timestamps | unsigned integer | seconds |

`WAD` = 1e18. `BPS` = 10,000. All arithmetic is exact integer arithmetic with no floating point.

**Input bounds.** Amounts must be at most 1e30, prices at most 1e24, and every basis-point value at most 10,000. Both implementations reject anything larger: TypeScript throws and Solidity reverts. These bounds keep every intermediate product under 2^256, so TypeScript's unbounded integers and Solidity's checked integers cannot diverge.

## 2. Parameters

| Name | Default | Meaning |
|---|---|---|
| `tauBps` | 75 | Gate tolerance |
| `muBps` | 10 | Band widening per side |
| `epsOutBps` | 100 | Outlier distance from the median |
| `epsHBps` | 10 | Health factor margin for `WRONGFUL` |
| `minSources` | 3 | Survivors needed for a band |
| `maxStalenessSec` | 3600 | Largest allowed distance between a source timestamp and `asOf` |

`maxStalenessSec` has no PRD default. See decision D5.

## 3. Rounding

Every rounding choice works against the payout.

| Value | Direction |
|---|---|
| Band low | down |
| Band high | up |
| Collateral value used for redress | down |
| Debt value used for redress | up |
| Entitlement | up |
| Redress | down, as a consequence of the three rows above |
| `hfWorst` | down at every step |
| `hfBest` | up at every step |
| Median of an even count | down |
| Confidence | down |

`floor(a·b/c)` and `ceil(a·b/c)` always multiply first and divide once.

## 4. Verdict enum

| Code | Name | Pays |
|---|---|---|
| 0 | `VALID` | 0 |
| 1 | `WRONGFUL` | Section 8 |
| 2 | `EXCESS` | Section 8 |
| 3 | `AMBIGUOUS` | Section 8 |
| 4 | `INCONCLUSIVE` | 0 |
| 5 | `OVERPRICED` | 0 |

Any other code pays 0.

## 5. Band

`buildBand(sources, cfg)` takes sources of `{price, timestamp}` and a config that includes `asOf`.

1. `queried` = number of sources passed in.
2. Drop a source if `price == 0` or `|asOf − timestamp| > maxStalenessSec`.
3. If none remain, return `INCONCLUSIVE`.
4. `m` = median of the remaining prices.
5. Drop `s` if `|s − m| · BPS > epsOutBps · m`. A source exactly at the limit stays.
6. `n` = survivors. If `n < minSources`, return `INCONCLUSIVE`.
7. `low = floor(min · (BPS − muBps) / BPS)` and `high = ceil(max · (BPS + muBps) / BPS)`.
8. `confidence = floor(n · BPS / queried)`.

A debt asset that is the numeraire uses a fixed band with `low = high = 1e18`, `n = 0` and `confidence = BPS`. It is not widened.

## 6. Gate

```
open = oracleCollateral · BPS < collateral.low · (BPS − tau)
    OR oracleDebt       · BPS > debt.high      · (BPS + tau)
```

Both comparisons are strict and exact, with no division.

## 7. Position and verdict

A position is `{A, D, ltBps, bonusBps}`. A liquidation is `{block, logIndex, C, X, oracleCollateral, oracleDebt}`, where `C` is gross of the protocol fee.

**Rebuild.** For one market and user in one block, order liquidations by `(block, logIndex)`. For liquidation `k`:

```
A_k = saturatingSub(A_0, ΣC_prev)
D_k = saturatingSub(D_0, ΣX_prev)
```

`A_0` and `D_0` are the balances at block `B − 1`. Liquidations in earlier blocks are already in those balances.

**Health factor.**

```
hfFloor(A, p_c, D, p_d, lt):
    if D == 0 or p_d == 0: return HF_MAX
    collateral = floor(A · p_c / WAD)
    adjusted   = floor(collateral · lt / BPS)
    debt       = ceil(D · p_d / WAD)
    return floor(adjusted · WAD / debt)

hfCeil(A, p_c, D, p_d, lt):
    same shape with collateral and adjusted rounded up, debt rounded down, result rounded up
    if the rounded debt is 0: return HF_MAX
```

`HF_MAX` = 2^256 − 1.

```
hfWorst = hfFloor(A, collateral.low,  D, debt.high, lt)
hfBest  = hfCeil (A, collateral.high, D, debt.low,  lt)
```

**Classification**, first match wins:

```
1. band is INCONCLUSIVE                     → INCONCLUSIVE   (both HF values are 0)
2. gate closed and oracleCollateral > high  → OVERPRICED
3. gate closed                              → VALID
4. hfWorst >= ceil(WAD · (BPS + epsHBps) / BPS) → WRONGFUL   (exact for an integer hfWorst; cannot overflow at HF_MAX)
5. hfBest < WAD and excess > 0              → EXCESS
6. hfBest < WAD                             → VALID
7. otherwise                                → AMBIGUOUS
```

## 8. Redress

```
collateralFloor = floor(C · collateral.low / WAD)
debtCeil        = ceil(X · debt.high / WAD)
entitlement     = ceil(debtCeil · (BPS + bonusBps) / BPS)
excess          = saturatingSub(collateralFloor, entitlement)

WRONGFUL            → saturatingSub(collateralFloor, debtCeil)
EXCESS, AMBIGUOUS   → excess
everything else     → 0
```

The result is in units of the numeraire. In the incident class that is ETH, paid as WETH.

## 9. Decisions

Each one resolves something the PRD leaves open.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Is `C` the event amount? | No. `C` is the event amount plus the protocol fee | The fee left the borrower. `Entitlement` is gross, so a net `C` would underpay every `EXCESS` |
| D2 | Where does `OVERPRICED` go in the enum? | Code 5, appended | Existing codes keep their meaning |
| D3 | Does `OVERPRICED` use `tau`? | No. Any oracle collateral price above `band.high` qualifies, if the gate is closed | The brief says "above the band". It pays 0 either way, so this only affects alerting |
| D4 | Collateral above the band and debt also above it? | The gate is open, so classification continues | Harm from the debt side still exists. `OVERPRICED` is only for cases with no harmful side |
| D5 | Staleness limit? | 3,600 s default, measured in both directions | The PRD gives none. An hour tolerates hourly off-chain snapshots. A source from after `asOf` is as misaligned as one from before |
| D6 | Does `minSources` count sources before or after outliers? | After | PRD 6.2 step 4 says survivors |
| D7 | Is a source at exactly `epsOutBps` an outlier? | No | PRD says "further than" |
| D8 | Does the numeraire debt asset get a widened band? | No | 1 WETH is 1 ETH by definition. Widening would invent uncertainty |
| D9 | Oracle debt price in the ETH numeraire? | `oracleDebt = 1e18`, `oracleCollateral = wstETH price / WETH price` from Aave | Removes the USD leg, which cancels |
| D10 | Rebuild underflow? | Saturate at 0 | Interest accrual can differ by a few wei. A revert would block a verdict |
| D11 | Zero debt? | `HF_MAX` | A debt-free position cannot be unhealthy |
| D12 | Is `EXCESS` allowed at `excess == 0`? | No, it stays `VALID` | PRD: promoted only if the seizure exceeds the entitlement |
| D13 | Can `AMBIGUOUS` pay when the gate is closed? | No. A closed gate returns before the interval check | PRD 6.3: a closed gate is recorded `VALID` |
| D14 | Scope of a position? | Key is market and user | One address held a position in both Core and Prime |
| D15 | Assets with other decimals? | Out of scope | The MVP class is 18-decimal wstETH and WETH |
| D16 | Multi-asset positions? | Out of scope for the engine. The replay flags them | PRD 8.8 |
