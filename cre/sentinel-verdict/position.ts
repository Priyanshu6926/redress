/**
 * Pure conversions from chain facts to engine inputs, shared by the CRE workflow and the
 * offline replay so the two cannot drift. No I/O, and safe to compile to WASM.
 */
import {
  INCONCLUSIVE, buildBand, fixedBand, rebuildPosition, redress, verdict,
  type EngineConfig, type Liquidation, type PairBand, type Position, type PriceSource, type VerdictOutcome,
} from "./verdict";

const WAD = 10n ** 18n;
const Q192 = 2n ** 192n;
export const LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Uniswap v3 TickMath.getSqrtRatioAtTick. */
export function sqrtRatioAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  if (abs > 887272n) throw new RangeError(`tick out of range: ${tick}`);
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const factors = [
    0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n,
  ];
  factors.forEach((f, i) => {
    if (abs & (1n << BigInt(i + 1))) ratio = (ratio * f) >> 128n;
  });
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** token1 per token0 at a tick, 1e18 fixed point, rounded down. Both tokens have 18 decimals. */
export function priceAtTick(tick: number): bigint {
  const s = sqrtRatioAtTick(tick);
  return (s * s * WAD) / Q192;
}

/** Arithmetic mean tick, rounded towards negative infinity as in Uniswap's OracleLibrary. */
export function meanTick(tickCumulativeStart: bigint, tickCumulativeEnd: bigint, windowSec: number): number {
  const delta = tickCumulativeEnd - tickCumulativeStart;
  const w = BigInt(windowSec);
  let tick = delta / w;
  if (delta < 0n && delta % w !== 0n) tick -= 1n;
  return Number(tick);
}

/** Aave's user configuration bitmap: bit 2i is borrowing, bit 2i+1 is collateral. */
export function countUserAssets(config: bigint): { borrows: number; collaterals: number } {
  let borrows = 0;
  let collaterals = 0;
  for (let i = 0n; i < 128n; i++) {
    if ((config >> (2n * i)) & 1n) borrows++;
    if ((config >> (2n * i + 1n)) & 1n) collaterals++;
  }
  return { borrows, collaterals };
}

export type RawLog = { address: string; topics: readonly string[]; data: string; logIndex: number };

/**
 * Finds the fee transfer belonging to one liquidation: the aToken Transfer from the user to
 * the treasury after the previous LiquidationCall in the tx and before this one.
 */
export function findProtocolFee(logs: readonly RawLog[], liquidationLogIndex: number, aToken: string, user: string, treasury: string): bigint {
  const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const previous = Math.max(-1, ...logs.filter((x) => x.topics[0] === LIQUIDATION_TOPIC && x.logIndex < liquidationLogIndex).map((x) => x.logIndex));
  let fee = 0n;
  for (const x of logs) {
    if (x.logIndex <= previous || x.logIndex >= liquidationLogIndex) continue;
    if (x.address.toLowerCase() !== aToken.toLowerCase() || x.topics[0] !== TRANSFER_TOPIC) continue;
    if (x.topics[1] === pad(user) && x.topics[2] === pad(treasury)) fee += BigInt(x.data);
  }
  return fee;
}

/** One off-chain price, as stored in replay/data/offchain-prices.json. */
export interface OffchainPrice {
  name: string;
  timestamp: number;
  price: string;
}

/** The chain facts one verdict depends on. Amounts and prices are decimal strings. */
export interface EventFacts {
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  debtToCover: string;
  collateralEvent: string;
  debtDecimals: number;
  protocolFee: string;
  lidoRate: string;
  twapPrice: string | null;
  /** Aave oracle, base currency, at block B. */
  oracleCollateral: string;
  oracleDebt: string;
  oracleWeth: string;
  /** Aave oracle and account state at block B - 1. */
  preOracleCollateral: string;
  preOracleWeth: string;
  preCollateralBalance: string;
  preDebtBalance: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  ltBps: string;
  bonusBps: string;
  borrows: number;
  collaterals: number;
}

/** Scales a token amount to 18 decimals. */
export function to18(amount: bigint, decimals: number): bigint {
  return decimals <= 18 ? amount * 10n ** BigInt(18 - decimals) : amount / 10n ** BigInt(decimals - 18);
}

export function collateralGross(r: Pick<EventFacts, "collateralEvent" | "protocolFee">): bigint {
  return BigInt(r.collateralEvent) + BigInt(r.protocolFee);
}

/** Debt price in the ETH numeraire. Exactly 1e18 for WETH. */
export function debtPriceEth(r: Pick<EventFacts, "oracleDebt" | "oracleWeth">): bigint {
  return (BigInt(r.oracleDebt) * WAD) / BigInt(r.oracleWeth);
}

export function isMultiAsset(r: Pick<EventFacts, "borrows" | "collaterals">): boolean {
  return r.borrows !== 1 || r.collaterals !== 1;
}

/**
 * Balances at block - 1. A single-asset position uses its token balances. A multi-asset
 * position keeps its wstETH and folds the rest in: other collateral at its Aave value,
 * converted to wstETH at the Lido rate, and all debt at its Aave value in the debt asset.
 */
export function basePosition(r: EventFacts): Position {
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

export function toLiquidation(r: EventFacts): Liquidation {
  return {
    block: BigInt(r.blockNumber),
    logIndex: r.logIndex,
    collateralSeized: collateralGross(r),
    debtCovered: to18(BigInt(r.debtToCover), r.debtDecimals),
    oracleCollateralPrice: (BigInt(r.oracleCollateral) * WAD) / BigInt(r.oracleWeth),
    oracleDebtPrice: debtPriceEth(r),
  };
}

/** The entry nearest to a timestamp for each named source. */
export function nearestPerSource(offchain: readonly OffchainPrice[], timestamp: number): OffchainPrice[] {
  const nearest = new Map<string, OffchainPrice>();
  for (const o of offchain) {
    const best = nearest.get(o.name);
    if (!best || Math.abs(o.timestamp - timestamp) < Math.abs(best.timestamp - timestamp)) nearest.set(o.name, o);
  }
  return [...nearest.values()];
}

/** S1, S2 and the nearest off-chain entry per named source. */
export function sourcesFor(r: Pick<EventFacts, "timestamp" | "lidoRate" | "twapPrice">, offchain: readonly OffchainPrice[]): PriceSource[] {
  const timestamp = BigInt(r.timestamp);
  const sources: PriceSource[] = [{ name: "S1 Lido stEthPerToken", price: BigInt(r.lidoRate), timestamp }];
  if (r.twapPrice) sources.push({ name: "S2 Uniswap v3 TWAP 30m", price: BigInt(r.twapPrice), timestamp });
  for (const o of nearestPerSource(offchain, r.timestamp)) {
    sources.push({ name: `S3 ${o.name}`, price: BigInt(o.price), timestamp: BigInt(o.timestamp) });
  }
  return sources;
}

export interface Assessment {
  sources: PriceSource[];
  band: PairBand | typeof INCONCLUSIVE;
  position: Position;
  target: Liquidation;
  outcome: VerdictOutcome;
  redress: bigint;
  debtPrice: bigint;
}

/** Runs the engine for one liquidation. `peers` are the same position's liquidations. */
export function assess(r: EventFacts, peers: Liquidation[], cfg: EngineConfig, offchain: readonly OffchainPrice[]): Assessment {
  const sources = sourcesFor(r, offchain);
  const built = buildBand(sources, { ...cfg, asOf: BigInt(r.timestamp) });
  const debtPrice = debtPriceEth(r);
  const band: PairBand | typeof INCONCLUSIVE = built === INCONCLUSIVE ? INCONCLUSIVE : { collateral: built, debt: fixedBand(debtPrice) };
  const target = toLiquidation(r);
  const position = rebuildPosition(basePosition(r), peers, target);
  const outcome = verdict(position, target, band, cfg);
  return { sources, band, position, target, outcome, redress: redress(position, target, band, outcome.verdict), debtPrice };
}
