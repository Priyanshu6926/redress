/**
 * Verdict engine. Pure functions, no I/O. docs/VERDICT_SPEC.md is the definition;
 * contracts/src/VerdictMath.sol must match this file bit for bit.
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const HF_MAX = 2n ** 256n - 1n;
export const MAX_AMOUNT = 10n ** 30n;
export const MAX_PRICE = 10n ** 24n;
export const INCONCLUSIVE = "INCONCLUSIVE" as const;

export enum VerdictType {
  VALID = 0,
  WRONGFUL = 1,
  EXCESS = 2,
  AMBIGUOUS = 3,
  INCONCLUSIVE = 4,
  OVERPRICED = 5,
}

export interface EngineConfig {
  name: string;
  tauBps: bigint;
  muBps: bigint;
  epsOutBps: bigint;
  epsHBps: bigint;
  minSources: number;
  maxStalenessSec: bigint;
}

export const DEFAULT_CONFIG: EngineConfig = {
  name: "default",
  tauBps: 75n,
  muBps: 10n,
  epsOutBps: 100n,
  epsHBps: 10n,
  minSources: 3,
  maxStalenessSec: 3600n,
};

export interface PriceSource {
  name: string;
  price: bigint;
  timestamp: bigint;
}

export interface Band {
  low: bigint;
  high: bigint;
  n: number;
  /** Survivors over sources queried, in basis points. */
  confidence: bigint;
}

export interface PairBand {
  collateral: Band;
  debt: Band;
}

export interface Position {
  /** Collateral balance A. */
  collateral: bigint;
  /** Debt balance D. */
  debt: bigint;
  ltBps: bigint;
  bonusBps: bigint;
}

export interface Liquidation {
  block: bigint;
  logIndex: number;
  /** Gross collateral C: event amount plus protocol fee. */
  collateralSeized: bigint;
  /** Debt repaid X. */
  debtCovered: bigint;
  oracleCollateralPrice: bigint;
  oracleDebtPrice: bigint;
}

export interface VerdictOutcome {
  verdict: VerdictType;
  hfBest: bigint;
  hfWorst: bigint;
}

const mulDivDown = (a: bigint, b: bigint, c: bigint): bigint => (a * b) / c;
const mulDivUp = (a: bigint, b: bigint, c: bigint): bigint => (a * b + c - 1n) / c;
const subOrZero = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

function assertAmount(v: bigint): void {
  if (v < 0n || v > MAX_AMOUNT) throw new RangeError(`amount out of bounds: ${v}`);
}

function assertPrice(v: bigint): void {
  if (v < 0n || v > MAX_PRICE) throw new RangeError(`price out of bounds: ${v}`);
}

function assertBps(...values: bigint[]): void {
  for (const v of values) if (v < 0n || v > BPS) throw new RangeError(`basis points out of bounds: ${v}`);
}

/** A fixed band for a debt asset that is the numeraire. */
export function fixedBand(price: bigint): Band {
  assertPrice(price);
  return { low: price, high: price, n: 0, confidence: BPS };
}

export function buildBand(sources: PriceSource[], cfg: EngineConfig & { asOf: bigint }): Band | typeof INCONCLUSIVE {
  sources.forEach((s) => assertPrice(s.price));
  assertBps(cfg.muBps, cfg.epsOutBps);
  const age = (t: bigint) => (cfg.asOf > t ? cfg.asOf - t : t - cfg.asOf);
  const usable = sources
    .filter((s) => s.price > 0n && age(s.timestamp) <= cfg.maxStalenessSec)
    .map((s) => s.price)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (usable.length === 0) return INCONCLUSIVE;

  const mid = usable.length >> 1;
  const m = usable.length % 2 === 1 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2n;

  const survivors = usable.filter((s) => (s > m ? s - m : m - s) * BPS <= cfg.epsOutBps * m);
  if (survivors.length < cfg.minSources || survivors.length === 0) return INCONCLUSIVE;

  return {
    low: mulDivDown(survivors[0]!, BPS - cfg.muBps, BPS),
    high: mulDivUp(survivors[survivors.length - 1]!, BPS + cfg.muBps, BPS),
    n: survivors.length,
    confidence: mulDivDown(BigInt(survivors.length), BPS, BigInt(sources.length)),
  };
}

export function gate(oracleCollateralPrice: bigint, oracleDebtPrice: bigint, band: PairBand, tauBps: bigint): boolean {
  assertPrice(oracleCollateralPrice);
  assertPrice(oracleDebtPrice);
  assertBps(tauBps);
  return (
    oracleCollateralPrice * BPS < band.collateral.low * (BPS - tauBps) ||
    oracleDebtPrice * BPS > band.debt.high * (BPS + tauBps)
  );
}

/** Lowest provable health factor: every rounding step goes down. */
export function hfFloor(a: bigint, pc: bigint, d: bigint, pd: bigint, ltBps: bigint): bigint {
  assertAmount(a);
  assertAmount(d);
  assertPrice(pc);
  assertPrice(pd);
  assertBps(ltBps);
  if (d === 0n || pd === 0n) return HF_MAX;
  const adjusted = mulDivDown(mulDivDown(a, pc, WAD), ltBps, BPS);
  return mulDivDown(adjusted, WAD, mulDivUp(d, pd, WAD));
}

/** Highest provable health factor: every rounding step goes up. */
export function hfCeil(a: bigint, pc: bigint, d: bigint, pd: bigint, ltBps: bigint): bigint {
  assertAmount(a);
  assertAmount(d);
  assertPrice(pc);
  assertPrice(pd);
  assertBps(ltBps);
  const debt = mulDivDown(d, pd, WAD);
  if (debt === 0n) return HF_MAX;
  const adjusted = mulDivUp(mulDivUp(a, pc, WAD), ltBps, BPS);
  return mulDivUp(adjusted, WAD, debt);
}

function excessOverEntitlement(position: Position, liquidation: Liquidation, band: PairBand): bigint {
  assertAmount(liquidation.collateralSeized);
  assertAmount(liquidation.debtCovered);
  assertBps(position.bonusBps);
  const collateralFloor = mulDivDown(liquidation.collateralSeized, band.collateral.low, WAD);
  const debtCeil = mulDivUp(liquidation.debtCovered, band.debt.high, WAD);
  return subOrZero(collateralFloor, mulDivUp(debtCeil, BPS + position.bonusBps, BPS));
}

export function verdict(
  position: Position,
  liquidation: Liquidation,
  band: PairBand | typeof INCONCLUSIVE,
  cfg: Pick<EngineConfig, "tauBps" | "epsHBps">,
): VerdictOutcome {
  if (band === INCONCLUSIVE) return { verdict: VerdictType.INCONCLUSIVE, hfBest: 0n, hfWorst: 0n };

  const hfWorst = hfFloor(position.collateral, band.collateral.low, position.debt, band.debt.high, position.ltBps);
  const hfBest = hfCeil(position.collateral, band.collateral.high, position.debt, band.debt.low, position.ltBps);
  const outcome = (v: VerdictType): VerdictOutcome => ({ verdict: v, hfBest, hfWorst });

  if (!gate(liquidation.oracleCollateralPrice, liquidation.oracleDebtPrice, band, cfg.tauBps)) {
    return outcome(liquidation.oracleCollateralPrice > band.collateral.high ? VerdictType.OVERPRICED : VerdictType.VALID);
  }
  assertBps(cfg.epsHBps);
  if (hfWorst >= mulDivUp(WAD, BPS + cfg.epsHBps, BPS)) return outcome(VerdictType.WRONGFUL);
  if (hfBest < WAD) {
    return outcome(excessOverEntitlement(position, liquidation, band) > 0n ? VerdictType.EXCESS : VerdictType.VALID);
  }
  return outcome(VerdictType.AMBIGUOUS);
}

export function redress(position: Position, liquidation: Liquidation, band: PairBand | typeof INCONCLUSIVE, v: VerdictType): bigint {
  if (band === INCONCLUSIVE) return 0n;
  if (v === VerdictType.WRONGFUL) {
    assertAmount(liquidation.collateralSeized);
    assertAmount(liquidation.debtCovered);
    return subOrZero(
      mulDivDown(liquidation.collateralSeized, band.collateral.low, WAD),
      mulDivUp(liquidation.debtCovered, band.debt.high, WAD),
    );
  }
  if (v === VerdictType.EXCESS || v === VerdictType.AMBIGUOUS) return excessOverEntitlement(position, liquidation, band);
  return 0n;
}

/**
 * Position just before `target`, given the balances at block - 1 and all liquidations of
 * this market and user. Only earlier liquidations in the same block are subtracted.
 */
export function rebuildPosition(base: Position, liquidations: Liquidation[], target: Liquidation): Position {
  const earlier = liquidations.filter((l) => l.block === target.block && l.logIndex < target.logIndex);
  return {
    ...base,
    collateral: subOrZero(base.collateral, earlier.reduce((sum, l) => sum + l.collateralSeized, 0n)),
    debt: subOrZero(base.debt, earlier.reduce((sum, l) => sum + l.debtCovered, 0n)),
  };
}
