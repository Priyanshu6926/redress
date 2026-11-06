/**
 * Turns cached reads into engine inputs and runs the verdict engine. Pure.
 */
import {
  DEFAULT_CONFIG, INCONCLUSIVE, VerdictType, buildBand, fixedBand, rebuildPosition, redress, verdict,
  type EngineConfig, type Liquidation, type PairBand, type Position, type PriceSource,
} from "../cre/sentinel-verdict/verdict";
import type { EventReads } from "./reads";

const WAD = 10n ** 18n;

export const CONFIGS: EngineConfig[] = [
  DEFAULT_CONFIG,
  { ...DEFAULT_CONFIG, name: "onchain-only-2src", minSources: 2 },
];

export function banner(cfg: EngineConfig): string {
  return `=== CONFIG ${cfg.name}: minSources=${cfg.minSources} tau=${cfg.tauBps} mu=${cfg.muBps} epsOut=${cfg.epsOutBps} epsH=${cfg.epsHBps} (bps) ===`;
}

/** One off-chain price, as stored in replay/data/offchain-prices.json. */
export interface OffchainPrice {
  name: string;
  timestamp: number;
  price: string;
}

/** Scales a token amount to 18 decimals. */
export function to18(amount: bigint, decimals: number): bigint {
  return decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18);
}

export function collateralGross(r: EventReads): bigint {
  return BigInt(r.collateralEvent) + BigInt(r.protocolFee);
}

/** Debt price in the ETH numeraire. Exactly 1e18 for WETH. */
export function debtPriceEth(r: EventReads): bigint {
  return (BigInt(r.oracleDebt) * WAD) / BigInt(r.oracleWeth);
}

export function isMultiAsset(r: EventReads): boolean {
  return r.borrows !== 1 || r.collaterals !== 1;
}

/**
 * Balances at block - 1. A single-asset position uses its token balances. A multi-asset
 * position keeps its wstETH and folds the rest in: other collateral at its Aave value,
 * converted to wstETH at the Lido rate, and all debt at its Aave value in the debt asset.
 */
export function basePosition(r: EventReads): Position {
  const ltBps = BigInt(r.ltBps);
  const bonusBps = BigInt(r.bonusBps);
  const wstEth = BigInt(r.preCollateralBalance);
  if (!isMultiAsset(r)) {
    return { collateral: wstEth, debt: to18(BigInt(r.preDebtBalance), r.debtDecimals), ltBps, bonusBps };
  }
  const weth = BigInt(r.preOracleWeth);
  const totalEth = (BigInt(r.totalCollateralBase) * WAD) / weth;
  const wstEthValue = (wstEth * BigInt(r.preOracleCollateral)) / weth;
  const otherEth = totalEth > wstEthValue ? totalEth - wstEthValue : 0n;
  const debtEth = (BigInt(r.totalDebtBase) * WAD) / weth;
  return {
    collateral: wstEth + (otherEth * WAD) / BigInt(r.lidoRate),
    debt: (debtEth * WAD) / debtPriceEth(r),
    ltBps,
    bonusBps,
  };
}

export function toLiquidation(r: EventReads): Liquidation {
  return {
    block: BigInt(r.blockNumber),
    logIndex: r.logIndex,
    collateralSeized: collateralGross(r),
    debtCovered: to18(BigInt(r.debtToCover), r.debtDecimals),
    oracleCollateralPrice: (BigInt(r.oracleCollateral) * WAD) / BigInt(r.oracleWeth),
    oracleDebtPrice: debtPriceEth(r),
  };
}

/** S1, S2 and, if a snapshot file was supplied, the nearest entry per named source. */
export function sourcesFor(r: EventReads, offchain: OffchainPrice[]): PriceSource[] {
  const timestamp = BigInt(r.timestamp);
  const sources: PriceSource[] = [{ name: "S1 Lido stEthPerToken", price: BigInt(r.lidoRate), timestamp }];
  if (r.twapPrice) sources.push({ name: "S2 Uniswap v3 TWAP 30m", price: BigInt(r.twapPrice), timestamp });

  const nearest = new Map<string, OffchainPrice>();
  for (const o of offchain) {
    const best = nearest.get(o.name);
    if (!best || Math.abs(o.timestamp - r.timestamp) < Math.abs(best.timestamp - r.timestamp)) nearest.set(o.name, o);
  }
  for (const o of nearest.values()) sources.push({ name: `S3 ${o.name}`, price: BigInt(o.price), timestamp: BigInt(o.timestamp) });
  return sources;
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
  sourcesUsed: string[];
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
    const sources = sourcesFor(r, offchain);
    const built = buildBand(sources, { ...cfg, asOf: BigInt(r.timestamp) });
    const debtPrice = debtPriceEth(r);
    const band: PairBand | typeof INCONCLUSIVE = built === INCONCLUSIVE ? INCONCLUSIVE : { collateral: built, debt: fixedBand(debtPrice) };

    const target = toLiquidation(r);
    const peers = (groups.get(`${r.pool}:${r.user}`.toLowerCase()) ?? []).map(toLiquidation);
    const position = rebuildPosition(basePosition(r), peers, target);
    const outcome = verdict(position, target, band, cfg);
    const pay = redress(position, target, band, outcome.verdict);

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
      sourcesUsed: sources.map((s) => s.name),
      sourcesAvailable: sources.length,
      gateOpen: band !== INCONCLUSIVE && outcome.verdict !== VerdictType.VALID && outcome.verdict !== VerdictType.OVERPRICED,
      multiAsset: isMultiAsset(r),
      bonusBps: r.bonusBps,
      ltBps: r.ltBps,
      impliedBonusBps: implied.toString(),
    };
  });
}
