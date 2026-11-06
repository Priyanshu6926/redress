#!/usr/bin/env python3
"""Generates contracts/test/vectors.json from docs/VERDICT_SPEC.md.

This is an independent reference: it uses exact fractions rather than the integer
tricks in verdict.ts and VerdictMath.sol, so expected values do not come from either
engine. Inputs are synthetic unless a vector's name says otherwise.

Run: python contracts/test/gen_vectors.py
"""
import json
import math
from decimal import Decimal
from fractions import Fraction as F
from pathlib import Path

WAD, BPS, HF_MAX = 10**18, 10_000, 2**256 - 1
T0 = 1_773_000_000  # arbitrary asOf for synthetic vectors


def e18(x):
    return int(Decimal(str(x)) * WAD)


def band(prices, stamps, c):
    live = [p for p, t in zip(prices, stamps) if p > 0 and abs(c["asOf"] - t) <= c["maxStalenessSec"]]
    if not live:
        return None
    live.sort()
    n = len(live)
    m = live[n // 2] if n % 2 else (live[n // 2 - 1] + live[n // 2]) // 2
    kept = [p for p in live if F(abs(p - m), m) <= F(c["epsOutBps"], BPS)]
    if len(kept) < c["minSources"] or not kept:
        return None
    return {
        "low": math.floor(F(min(kept)) * F(BPS - c["muBps"], BPS)),
        "high": math.ceil(F(max(kept)) * F(BPS + c["muBps"], BPS)),
        "n": len(kept),
        "confidence": math.floor(F(len(kept) * BPS, len(prices))),
    }


def hf_worst(a, pc, d, pd, lt):
    if d == 0 or pd == 0:
        return HF_MAX
    collateral = math.floor(F(a * pc, WAD))
    adjusted = math.floor(F(collateral * lt, BPS))
    return math.floor(F(adjusted * WAD, math.ceil(F(d * pd, WAD))))


def hf_best(a, pc, d, pd, lt):
    debt = math.floor(F(d * pd, WAD))
    if debt == 0:
        return HF_MAX
    collateral = math.ceil(F(a * pc, WAD))
    adjusted = math.ceil(F(collateral * lt, BPS))
    return math.ceil(F(adjusted * WAD, debt))


def evaluate(v):
    b = band(v["sourcePrices"], v["sourceTimestamps"], v)
    out = {"bandOk": 0, "low": 0, "high": 0, "n": 0, "confidence": 0, "gate": 0, "verdict": 4, "hfBest": 0, "hfWorst": 0, "redress": 0}
    if b is None:
        return out
    out.update(bandOk=1, **b)
    a = max(0, v["A"] - sum(v["earlierC"]))
    d = max(0, v["D"] - sum(v["earlierX"]))
    low, high, dlow, dhigh = b["low"], b["high"], v["debtLow"], v["debtHigh"]
    worst = hf_worst(a, low, d, dhigh, v["ltBps"])
    best = hf_best(a, high, d, dlow, v["ltBps"])
    tau = v["tauBps"]
    is_open = F(v["oracleCollateral"]) < F(low) * F(BPS - tau, BPS) or F(v["oracleDebt"]) > F(dhigh) * F(BPS + tau, BPS)

    coll = math.floor(F(v["C"] * low, WAD))
    debt = math.ceil(F(v["X"] * dhigh, WAD))
    ent = math.ceil(F(debt * (BPS + v["bonusBps"]), BPS))
    excess = max(0, coll - ent)

    if not is_open:
        verdict = 5 if v["oracleCollateral"] > high else 0
    elif F(worst, WAD) >= 1 + F(v["epsHBps"], BPS):
        verdict = 1
    elif best < WAD:
        verdict = 2 if excess > 0 else 0
    else:
        verdict = 3
    pay = max(0, coll - debt) if verdict == 1 else excess if verdict in (2, 3) else 0
    out.update(gate=int(is_open), verdict=verdict, hfBest=best, hfWorst=worst, redress=pay)
    return out


def vector(name, prices, **kw):
    v = {
        "name": name, "asOf": T0, "tauBps": 75, "muBps": 10, "epsOutBps": 100, "epsHBps": 10,
        "minSources": 3, "maxStalenessSec": 3600,
        "sourcePrices": [e18(p) for p in prices], "sourceTimestamps": [T0] * len(prices),
        "debtLow": WAD, "debtHigh": WAD, "A": e18(300), "D": e18(345.16), "ltBps": 9550, "bonusBps": 100,
        "earlierC": [], "earlierX": [], "C": e18(145), "X": e18(172.58),
        "oracleCollateral": e18(1.193957), "oracleDebt": WAD,
    }
    v.update(kw)
    v["expected"] = evaluate(v)
    return v


MARKET = [1.2284, 1.2288, 1.2293]
X_A = e18(172.58)
C_A = X_A * 101 * WAD // (100 * e18(1.193957))
ZERO = {"muBps": 0}

vectors = [
    vector("Appendix A", MARKET, C=C_A, X=X_A),
    vector("HF exactly 1 is AMBIGUOUS", [1, 1, 1], A=e18(100), D=e18(95), ltBps=9500, C=e18(50), X=e18(45), oracleCollateral=e18(0.9), **ZERO),
    vector("HF exactly 1+eps_h is WRONGFUL", [1, 1, 1], A=e18(1001), D=e18(1000), ltBps=10000, C=e18(50), X=e18(45), oracleCollateral=e18(0.9), **ZERO),
    vector("HF one wei under 1+eps_h is AMBIGUOUS", [1, 1, 1], A=e18(1001) - 1, D=e18(1000), ltBps=10000, C=e18(50), X=e18(45), oracleCollateral=e18(0.9), **ZERO),
    vector("HF below 1 with no excess is VALID", [1, 1, 1], A=e18(100), D=e18(100), ltBps=9000, C=e18(101), X=e18(100), oracleCollateral=e18(0.9), **ZERO),
    vector("HF below 1 with excess is EXCESS", [1, 1, 1], A=e18(100), D=e18(100), ltBps=9000, C=e18(105), X=e18(100), oracleCollateral=e18(0.9), **ZERO),
    vector("one source 5% off is rejected", [1.2288, 1.2290, 1.2292, 1.2906], C=C_A, X=X_A),
    vector("only two usable sources is INCONCLUSIVE", [1.2288, 1.2290], C=C_A, X=X_A),
    vector("two sources pass at minSources 2", [1.2288, 1.2290], C=C_A, X=X_A, minSources=2),
    vector("oracle above band is OVERPRICED", MARKET, oracleCollateral=e18(1.30), C=C_A, X=X_A),
    vector("market-driven drop is VALID", [1.0998, 1.1000, 1.1002], oracleCollateral=e18(1.1), C=e18(100), X=e18(108)),
    vector("second liquidation in one block", MARKET, earlierC=[C_A], earlierX=[X_A], C=e18(70), X=e18(80)),
    vector("three liquidations in one block", MARKET, earlierC=[e18(50), e18(40)], earlierX=[e18(58), e18(46)], C=e18(30), X=e18(35)),
    vector("zero-width band", [1.2288, 1.2288, 1.2288], C=C_A, X=X_A, **ZERO),
    vector("stale source dropped", MARKET + [1.2290], sourceTimestamps=[T0, T0, T0, T0 - 3601], C=C_A, X=X_A),
    vector("source exactly at the staleness limit stays", MARKET, sourceTimestamps=[T0, T0, T0 - 3600], C=C_A, X=X_A),
    vector("future-dated source dropped", MARKET, sourceTimestamps=[T0, T0, T0 + 3601], C=C_A, X=X_A),
    vector("stale source leaves too few", MARKET, sourceTimestamps=[T0, T0, T0 - 3601], C=C_A, X=X_A),
    vector("zero-price source dropped", MARKET + [0], C=C_A, X=X_A),
    vector("no sources is INCONCLUSIVE", [], C=C_A, X=X_A),
    vector("source exactly at eps_out stays", [0.99, 1, 1.01], oracleCollateral=e18(0.9), C=e18(50), X=e18(45), A=e18(100), D=e18(50)),
    vector("source just past eps_out goes", [0.989, 1, 1, 1.01], oracleCollateral=e18(0.9), C=e18(50), X=e18(45), A=e18(100), D=e18(50)),
    # With eps_out 0 only a source equal to the median survives, so the median's rounding decides which one.
    vector("even source count takes the floored median", [1, 1.000000000000000001], oracleCollateral=e18(0.9), minSources=1, epsOutBps=0, C=e18(50), X=e18(45), A=e18(100), D=e18(50), **ZERO),
    vector("gate exactly at tau stays closed", [1, 1, 1], oracleCollateral=e18(0.9925), C=e18(50), X=e18(45), A=e18(100), D=e18(50), **ZERO),
    vector("gate one wei past tau opens", [1, 1, 1], oracleCollateral=e18(0.9925) - 1, C=e18(50), X=e18(45), A=e18(100), D=e18(50), **ZERO),
    vector("debt priced above band opens the gate", [1, 1, 1], oracleCollateral=e18(1), oracleDebt=e18(1.05), A=e18(100), D=e18(50), C=e18(50), X=e18(45), **ZERO),
    vector("collateral and debt both above band still classifies", [1, 1, 1], oracleCollateral=e18(1.2), oracleDebt=e18(1.05), A=e18(100), D=e18(50), C=e18(50), X=e18(45), **ZERO),
    vector("debt band above numeraire raises debt value", [1, 1, 1], debtLow=e18(1), debtHigh=e18(1.002), A=e18(100), D=e18(50), C=e18(50), X=e18(45), oracleCollateral=e18(0.9), **ZERO),
    vector("wrongful clamps at zero", MARKET, C=e18(100), X=e18(150)),
    vector("rounding: redress of tiny amounts floors collateral and ceils debt", [1.5, 1.5, 1.5], A=e18(100), D=e18(10), C=3, X=1, oracleCollateral=e18(1), **ZERO),
    vector("rounding: entitlement ceils", [1, 1, 1], A=e18(100), D=e18(100), ltBps=9000, C=1000, X=333, debtHigh=e18(1.5), oracleCollateral=e18(0.9), **ZERO),
    vector("rebuild saturates collateral at zero", MARKET, earlierC=[e18(301)], earlierX=[e18(1)], C=C_A, X=X_A),
    vector("rebuild saturates debt at zero", MARKET, earlierC=[e18(1)], earlierX=[e18(346)], C=C_A, X=X_A),
    vector("zero debt gives maximum health factor", MARKET, D=0, C=C_A, X=X_A),
]

# Fixed facts checked here so that a generator bug cannot pass silently.
expected_by_name = {v["name"]: v["expected"] for v in vectors}
assert expected_by_name["Appendix A"]["verdict"] == 1
assert abs(F(expected_by_name["Appendix A"]["redress"], WAD) - F("6.575")) < F("0.01")
assert expected_by_name["HF exactly 1 is AMBIGUOUS"]["verdict"] == 3
assert expected_by_name["HF exactly 1+eps_h is WRONGFUL"]["verdict"] == 1
assert expected_by_name["HF one wei under 1+eps_h is AMBIGUOUS"]["verdict"] == 3
assert expected_by_name["one source 5% off is rejected"]["n"] == 3
assert expected_by_name["only two usable sources is INCONCLUSIVE"]["bandOk"] == 0
assert expected_by_name["oracle above band is OVERPRICED"]["verdict"] == 5
assert expected_by_name["market-driven drop is VALID"]["verdict"] == 0
assert expected_by_name["stale source dropped"]["n"] == 3
assert expected_by_name["even source count takes the floored median"]["high"] == WAD
assert expected_by_name["gate exactly at tau stays closed"]["gate"] == 0
assert expected_by_name["gate one wei past tau opens"]["gate"] == 1


def stringify(x):
    if isinstance(x, dict):
        return {k: stringify(val) for k, val in x.items()}
    if isinstance(x, list):
        return [stringify(val) for val in x]
    return str(x) if isinstance(x, int) else x


out = Path(__file__).parent / "vectors.json"
out.write_text(json.dumps({"count": len(vectors), "vectors": stringify(vectors)}, indent=1) + "\n", encoding="utf8")
print(f"wrote {len(vectors)} vectors; Appendix A redress = {float(F(expected_by_name['Appendix A']['redress'], WAD)):.6f}")
for v in vectors:
    e = v["expected"]
    print(f"  {e['verdict']} gate={e['gate']} n={e['n']} redress={float(F(e['redress'], WAD)):.6f}  {v['name']}")
