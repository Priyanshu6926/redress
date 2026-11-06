import { describe, expect, test } from "bun:test";
import file from "../../contracts/test/vectors.json";
import {
  DEFAULT_CONFIG, INCONCLUSIVE, MAX_AMOUNT, MAX_PRICE, VerdictType, buildBand, gate, hfFloor, rebuildPosition, redress, verdict,
  type Liquidation, type PairBand, type Position,
} from "./verdict";

const big = (s: string) => BigInt(s);

function run(v: (typeof file.vectors)[number]) {
  const cfg = {
    name: "vector",
    tauBps: big(v.tauBps),
    muBps: big(v.muBps),
    epsOutBps: big(v.epsOutBps),
    epsHBps: big(v.epsHBps),
    minSources: Number(v.minSources),
    maxStalenessSec: big(v.maxStalenessSec),
    asOf: big(v.asOf),
  };
  const sources = v.sourcePrices.map((price, i) => ({ name: `s${i}`, price: big(price), timestamp: big(v.sourceTimestamps[i]!) }));
  const collateral = buildBand(sources, cfg);
  const debt = { low: big(v.debtLow), high: big(v.debtHigh), n: 0, confidence: 10_000n };
  const band: PairBand | typeof INCONCLUSIVE = collateral === INCONCLUSIVE ? INCONCLUSIVE : { collateral, debt };

  const base: Position = { collateral: big(v.A), debt: big(v.D), ltBps: big(v.ltBps), bonusBps: big(v.bonusBps) };
  const earlier: Liquidation[] = v.earlierC.map((c, i) => ({
    block: 1n, logIndex: i, collateralSeized: big(c), debtCovered: big(v.earlierX[i]!), oracleCollateralPrice: 0n, oracleDebtPrice: 0n,
  }));
  const target: Liquidation = {
    block: 1n, logIndex: earlier.length, collateralSeized: big(v.C), debtCovered: big(v.X),
    oracleCollateralPrice: big(v.oracleCollateral), oracleDebtPrice: big(v.oracleDebt),
  };
  const position = rebuildPosition(base, [...earlier, target], target);
  const outcome = verdict(position, target, band, cfg);
  return {
    collateral, band, outcome,
    gateOpen: band === INCONCLUSIVE ? false : gate(target.oracleCollateralPrice, target.oracleDebtPrice, band, cfg.tauBps),
    pay: redress(position, target, band, outcome.verdict),
  };
}

describe("shared vectors", () => {
  test("count matches", () => expect(file.vectors.length).toBe(Number(file.count)));

  for (const v of file.vectors) {
    test(v.name, () => {
      const r = run(v);
      const e = v.expected;
      if (e.bandOk === "1") {
        if (r.collateral === INCONCLUSIVE) throw new Error("expected a band");
        expect(r.collateral.low).toBe(big(e.low));
        expect(r.collateral.high).toBe(big(e.high));
        expect(BigInt(r.collateral.n)).toBe(big(e.n));
        expect(r.collateral.confidence).toBe(big(e.confidence));
      } else {
        expect(r.collateral).toBe(INCONCLUSIVE);
      }
      expect(r.gateOpen ? "1" : "0").toBe(e.gate);
      expect(BigInt(r.outcome.verdict)).toBe(big(e.verdict));
      expect(r.outcome.hfWorst).toBe(big(e.hfWorst));
      expect(r.outcome.hfBest).toBe(big(e.hfBest));
      expect(r.pay).toBe(big(e.redress));
    });
  }
});

describe("rebuildPosition", () => {
  const liq = (block: bigint, logIndex: number, c: bigint, x: bigint): Liquidation => ({
    block, logIndex, collateralSeized: c, debtCovered: x, oracleCollateralPrice: 0n, oracleDebtPrice: 0n,
  });
  const base: Position = { collateral: 100n, debt: 90n, ltBps: 9500n, bonusBps: 100n };

  test("ignores input order", () => {
    const a = liq(5n, 2, 10n, 9n);
    const b = liq(5n, 7, 20n, 18n);
    const target = liq(5n, 9, 1n, 1n);
    expect(rebuildPosition(base, [target, b, a], target)).toEqual({ ...base, collateral: 70n, debt: 63n });
  });

  test("ignores later logs and other blocks", () => {
    const target = liq(5n, 4, 1n, 1n);
    const r = rebuildPosition(base, [liq(4n, 1, 10n, 9n), liq(5n, 8, 20n, 18n), liq(6n, 1, 5n, 5n), target], target);
    expect(r).toEqual(base);
  });
});

describe("bounds", () => {
  test("rejects inputs that Solidity would reject", () => {
    expect(() => hfFloor(MAX_AMOUNT + 1n, 1n, 1n, 1n, 1n)).toThrow(RangeError);
    expect(() => hfFloor(1n, MAX_PRICE + 1n, 1n, 1n, 1n)).toThrow(RangeError);
    expect(() => buildBand([{ name: "x", price: MAX_PRICE + 1n, timestamp: 0n }], { ...DEFAULT_CONFIG, asOf: 0n })).toThrow(RangeError);
  });
});

describe("redress", () => {
  const band: PairBand = { collateral: { low: 10n ** 18n, high: 10n ** 18n, n: 3, confidence: 10_000n }, debt: { low: 10n ** 18n, high: 10n ** 18n, n: 0, confidence: 10_000n } };
  const position: Position = { collateral: 100n, debt: 50n, ltBps: 9500n, bonusBps: 100n };
  const l: Liquidation = { block: 1n, logIndex: 0, collateralSeized: 100n, debtCovered: 10n, oracleCollateralPrice: 0n, oracleDebtPrice: 0n };

  test("pays nothing for VALID, INCONCLUSIVE, OVERPRICED and unknown codes", () => {
    for (const v of [VerdictType.VALID, VerdictType.INCONCLUSIVE, VerdictType.OVERPRICED, 9 as VerdictType]) {
      expect(redress(position, l, band, v)).toBe(0n);
    }
    expect(redress(position, l, INCONCLUSIVE, VerdictType.WRONGFUL)).toBe(0n);
  });
});
