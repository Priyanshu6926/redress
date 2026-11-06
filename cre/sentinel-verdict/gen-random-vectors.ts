/**
 * Writes contracts/test/vectors-random.bin: seeded random cases with results from
 * verdict.ts, replayed by VerdictMath.t.sol to check bit-for-bit agreement without FFI.
 * Layout: one word holding the count, then 39 big-endian words per record.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BPS, INCONCLUSIVE, VerdictType, WAD, buildBand, gate, rebuildPosition, redress, verdict, type Liquidation, type PairBand } from "./verdict";

const COUNT = 10_000;
const SEED = 20260310;

let state = SEED;
function rand(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number) => BigInt(lo + Math.floor(rand() * (hi - lo + 1)));
const pct = (v: bigint, bps: bigint) => (v * (BPS + bps)) / BPS;
const wei = () => BigInt(Math.floor(rand() * 2 ** 40));

function record() {
  const asOf = 1_773_000_000n + int(0, 1_000_000);
  const cfg = {
    name: "random", tauBps: int(0, 200), muBps: int(0, 50), epsOutBps: int(5, 200), epsHBps: int(0, 50),
    minSources: Number(int(1, 4)), maxStalenessSec: int(600, 7200), asOf,
  };
  const base = int(1000, 1300) * 10n ** 15n + wei();

  const prices: bigint[] = [];
  const stamps: bigint[] = [];
  for (let i = 0; i < 5; i++) {
    const r = rand();
    prices.push(r < 0.1 ? 0n : r < 0.25 ? pct(base, int(-600, 600)) : pct(base, int(-20, 20)) + wei());
    stamps.push(rand() < 0.15 ? asOf - cfg.maxStalenessSec - int(0, 2) : asOf + int(-500, 500));
  }

  const debtLow = rand() < 0.7 ? WAD : WAD - int(0, 2) * 10n ** 15n;
  const debtHigh = debtLow === WAD ? WAD : WAD + int(0, 3) * 10n ** 15n;
  const ltBps = int(9000, 9700);
  const bonusBps = int(0, 600);

  const A = rand() < 0.03 ? int(0, 5) : int(1, 100_000) * WAD + wei();
  const mode = rand();
  const hfTarget = int(9000, 11000);
  const D = mode < 0.03 ? 0n : mode < 0.06 ? int(0, 5) : (((A * base) / WAD) * ltBps * BPS) / BPS / hfTarget;
  const X = rand() < 0.03 ? int(0, 5) : (D * int(0, 10000)) / BPS;

  const oc = rand() < 0.05 ? 0n : pct(base, int(-600, 300));
  const od = rand() < 0.85 ? WAD : pct(WAD, int(-100, 500));
  const C = rand() < 0.03 ? int(0, 5) : (X * (BPS + bonusBps) * int(9000, 11500)) / BPS / BPS;
  const earlierC = rand() < 0.2 ? (A * int(0, 12000)) / BPS : 0n;
  const earlierX = rand() < 0.2 ? (D * int(0, 12000)) / BPS : 0n;

  const sources = prices.map((price, i) => ({ name: `s${i}`, price, timestamp: stamps[i]! }));
  const collateral = buildBand(sources, cfg);
  const debt = { low: debtLow, high: debtHigh, n: 0, confidence: BPS };
  const band: PairBand | typeof INCONCLUSIVE = collateral === INCONCLUSIVE ? INCONCLUSIVE : { collateral, debt };

  const earlier: Liquidation = { block: 1n, logIndex: 0, collateralSeized: earlierC, debtCovered: earlierX, oracleCollateralPrice: 0n, oracleDebtPrice: 0n };
  const target: Liquidation = { block: 1n, logIndex: 1, collateralSeized: C, debtCovered: X, oracleCollateralPrice: oc, oracleDebtPrice: od };
  const position = rebuildPosition({ collateral: A, debt: D, ltBps, bonusBps }, [earlier, target], target);
  const outcome = verdict(position, target, band, cfg);
  const pay = redress(position, target, band, outcome.verdict);
  const open = band !== INCONCLUSIVE && gate(oc, od, band, cfg.tauBps);
  const ok = collateral !== INCONCLUSIVE;

  const words = [
    asOf, cfg.tauBps, cfg.muBps, cfg.epsOutBps, cfg.epsHBps, BigInt(cfg.minSources), cfg.maxStalenessSec,
    ...prices, ...stamps, debtLow, debtHigh, A, D, ltBps, bonusBps, C, X, oc, od, earlierC, earlierX,
    ok ? 1n : 0n, ok ? collateral.low : 0n, ok ? collateral.high : 0n, ok ? BigInt(collateral.n) : 0n, ok ? collateral.confidence : 0n,
    open ? 1n : 0n, BigInt(outcome.verdict), outcome.hfBest, outcome.hfWorst, pay,
  ];
  return { words, verdict: outcome.verdict, paid: pay > 0n };
}

const hex = (v: bigint) => v.toString(16).padStart(64, "0");
const parts = [hex(BigInt(COUNT))];
const tally = new Map<VerdictType, number>();
let paid = 0;
for (let i = 0; i < COUNT; i++) {
  const r = record();
  if (r.words.length !== 39) throw new Error(`record has ${r.words.length} words`);
  parts.push(r.words.map(hex).join(""));
  tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
  if (r.paid) paid++;
}

for (const v of [0, 1, 2, 3, 4, 5] as VerdictType[]) {
  if (!tally.get(v)) throw new Error(`random set never produced verdict ${VerdictType[v]}`);
}
const path = join(import.meta.dir, "..", "..", "contracts", "test", "vectors-random.bin");
writeFileSync(path, Buffer.from(parts.join(""), "hex"));
console.log(`wrote ${COUNT} vectors, ${paid} with a payout:`, Object.fromEntries([...tally].map(([v, n]) => [VerdictType[v], n])));
