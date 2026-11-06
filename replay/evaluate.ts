/**
 * Runs the verdict engine over cached reads for the replay. The conversions live in
 * cre/sentinel-verdict/position.ts, which the CRE workflow shares.
 */
import { assess, isMultiAsset, type OffchainPrice } from "../cre/sentinel-verdict/position";
import { DEFAULT_CONFIG, INCONCLUSIVE, VerdictType, type EngineConfig, type PriceSource } from "../cre/sentinel-verdict/verdict";
import { toLiquidation } from "../cre/sentinel-verdict/position";
import type { EventReads } from "./reads";

export { basePosition, collateralGross, debtPriceEth, isMultiAsset, sourcesFor, to18, toLiquidation, type OffchainPrice } from "../cre/sentinel-verdict/position";

const WAD = 10n ** 18n;

export const CONFIGS: EngineConfig[] = [
  DEFAULT_CONFIG,
  { ...DEFAULT_CONFIG, name: "onchain-only-2src", minSources: 2 },
];

/** A config named onchain-only must never see off-chain prices. */
export function offchainFor(cfg: EngineConfig, offchain: OffchainPrice[]): OffchainPrice[] {
  return cfg.name.startsWith("onchain-only") ? [] : offchain;
}

export function banner(cfg: EngineConfig): string {
  return `=== CONFIG ${cfg.name}: minSources=${cfg.minSources} tau=${cfg.tauBps} mu=${cfg.muBps} epsOut=${cfg.epsOutBps} epsH=${cfg.epsHBps} (bps) ===`;
}

export interface Row {
  market: string;
  user: string;
  txHash: string;
  block: number;
  logIndex: number;
  debtAsset: string;
  verdict: string;
  hfWorst: string;
  hfBest: string;
  redress: string;
  /** C · band midpoint − X · debt price, floored at 0. A point estimate, not a payable amount. */
  lossAtBandMid: string;
  bandLow: string;
  bandHigh: string;
  /** Sources that survived staleness and outlier checks. */
  sourcesUsed: string[];
  /** Sources queried but dropped, with their prices kept out of the band. */
  sourcesRejected: string[];
  sourcesAvailable: number;
  gateOpen: boolean;
  multiAsset: boolean;
  bonusBps: string;
  ltBps: string;
  impliedBonusBps: string;
}

export function evaluate(reads: EventReads[], cfg: EngineConfig, offchain: OffchainPrice[] = []): Row[] {
  const ordered = [...reads].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const groups = new Map<string, EventReads[]>();
  for (const r of ordered) {
    const key = `${r.pool}:${r.user}`.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return ordered.map((r) => {
    const peers = (groups.get(`${r.pool}:${r.user}`.toLowerCase()) ?? []).map(toLiquidation);
    const { sources, band, target, outcome, redress: pay, debtPrice } = assess(r, peers, cfg, offchain);

    // Rejected sources sit outside the band: eps_out is wider than the mu widening.
    const inBand = (s: PriceSource) => band !== INCONCLUSIVE && s.price >= band.collateral.low && s.price <= band.collateral.high;
    const mid = band === INCONCLUSIVE ? 0n : (band.collateral.low + band.collateral.high) / 2n;
    const loss = (target.collateralSeized * mid) / WAD - (target.debtCovered * debtPrice) / WAD;
    const implied = target.debtCovered === 0n ? 0n
      : (target.collateralSeized * target.oracleCollateralPrice * 10_000n) / (target.debtCovered * debtPrice) - 10_000n;

    return {
      market: r.market,
      user: r.user,
      txHash: r.txHash,
      block: r.blockNumber,
      logIndex: r.logIndex,
      debtAsset: r.debtAsset,
      verdict: VerdictType[outcome.verdict]!,
      hfWorst: outcome.hfWorst.toString(),
      hfBest: outcome.hfBest.toString(),
      redress: pay.toString(),
      lossAtBandMid: (band === INCONCLUSIVE || loss < 0n ? 0n : loss).toString(),
      bandLow: band === INCONCLUSIVE ? "0" : band.collateral.low.toString(),
      bandHigh: band === INCONCLUSIVE ? "0" : band.collateral.high.toString(),
      sourcesUsed: sources.filter(inBand).map((s) => s.name),
      sourcesRejected: sources.filter((s) => !inBand(s)).map((s) => s.name),
      sourcesAvailable: sources.length,
      gateOpen: band !== INCONCLUSIVE && outcome.verdict !== VerdictType.VALID && outcome.verdict !== VerdictType.OVERPRICED,
      multiAsset: isMultiAsset(r),
      bonusBps: r.bonusBps,
      ltBps: r.ltBps,
      impliedBonusBps: implied.toString(),
    };
  });
}
