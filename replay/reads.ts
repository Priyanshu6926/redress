/**
 * Archive reads for one liquidation, plus the pure conversions that turn them into
 * engine inputs. Reads are cached in replay/data so the replay runs without an RPC.
 */
import { parseAbi, type Address, type Hash, type PublicClient } from "viem";
import { effectiveBonusBps } from "../cre/sentinel-verdict/bonus";
import { CHAINLINK_STETH_ETH_FEED, WETH, WSTETH, erc20Abi, findProtocolFee, oracleAbi, poolAbi, v3PoolAbi, wstEthAbi } from "./onchain";

/** Deepest wstETH/WETH pool, chosen in replay/data/verification-report.txt. token0 is wstETH. */
export const UNISWAP_POOL: Address = "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa";
export const TWAP_WINDOW_SEC = 1800;

const WAD = 10n ** 18n;
const Q192 = 2n ** 192n;

const poolConfigAbi = parseAbi([
  "function getConfiguration(address asset) view returns (uint256)",
  "function getUserConfiguration(address user) view returns (uint256)",
  "function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)",
  "struct ReserveConfigurationMap { uint256 data; }",
  "struct ReserveDataLegacy { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }",
  "function getReserveData(address asset) view returns (ReserveDataLegacy)",
]);
const feedAbi = parseAbi(["function latestAnswer() view returns (int256)"]);
const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

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

/** Lowest set bits of Aave's user configuration: bit 2i borrowing, bit 2i+1 collateral. */
export function countUserAssets(config: bigint): { borrows: number; collaterals: number } {
  let borrows = 0;
  let collaterals = 0;
  for (let i = 0n; i < 128n; i++) {
    if ((config >> (2n * i)) & 1n) borrows++;
    if ((config >> (2n * i + 1n)) & 1n) collaterals++;
  }
  return { borrows, collaterals };
}

export interface EventInput {
  market: string;
  pool: Address;
  oracle: Address;
  aToken: Address;
  debtToken: Address;
  txHash: Hash;
  blockNumber: number;
  logIndex: number;
  user: Address;
  debtAsset: Address;
  debtToCover: string;
  collateralEvent: string;
}

/** Everything read from chain for one liquidation. Amounts and prices are decimal strings. */
export interface EventReads extends EventInput {
  timestamp: number;
  debtDecimals: number;
  protocolFee: string;
  lidoRate: string;
  twapTick: number | null;
  twapPrice: string | null;
  chainlinkStEthEth: string;
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
  eModeId: number;
  borrows: number;
  collaterals: number;
}

export async function readEvent(c: PublicClient, e: EventInput, treasury: Address): Promise<EventReads> {
  const B = BigInt(e.blockNumber);
  const P = B - 1n;
  const asset = (address: Address, blockNumber: bigint) => c.readContract({ address: e.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [address], blockNumber });

  const [block, receipt, lidoRate, feed, debtDecimals, oc, od, ow, poc, pow, a, d, acct, eModeId, userConfig, reserveConfig] = await Promise.all([
    c.getBlock({ blockNumber: B }),
    c.getTransactionReceipt({ hash: e.txHash }),
    c.readContract({ address: WSTETH, abi: wstEthAbi, functionName: "stEthPerToken", blockNumber: B }),
    c.readContract({ address: CHAINLINK_STETH_ETH_FEED, abi: feedAbi, functionName: "latestAnswer", blockNumber: B }),
    c.readContract({ address: e.debtAsset, abi: decimalsAbi, functionName: "decimals" }),
    asset(WSTETH, B),
    asset(e.debtAsset, B),
    asset(WETH, B),
    asset(WSTETH, P),
    asset(WETH, P),
    c.readContract({ address: e.aToken, abi: erc20Abi, functionName: "balanceOf", args: [e.user], blockNumber: P }),
    c.readContract({ address: e.debtToken, abi: erc20Abi, functionName: "balanceOf", args: [e.user], blockNumber: P }),
    c.readContract({ address: e.pool, abi: poolAbi, functionName: "getUserAccountData", args: [e.user], blockNumber: P }),
    c.readContract({ address: e.pool, abi: poolAbi, functionName: "getUserEMode", args: [e.user], blockNumber: P }),
    c.readContract({ address: e.pool, abi: poolConfigAbi, functionName: "getUserConfiguration", args: [e.user], blockNumber: P }),
    c.readContract({ address: e.pool, abi: poolConfigAbi, functionName: "getConfiguration", args: [WSTETH], blockNumber: P }),
  ]);

  const reserve = await c.readContract({ address: e.pool, abi: poolConfigAbi, functionName: "getReserveData", args: [WSTETH], blockNumber: P });
  let eModeBonus = 0n;
  let collateralBitmap = 0n;
  if (eModeId !== 0n) {
    const cfg = await c.readContract({ address: e.pool, abi: poolAbi, functionName: "getEModeCategoryCollateralConfig", args: [Number(eModeId)], blockNumber: P });
    eModeBonus = BigInt(cfg.liquidationBonus);
    collateralBitmap = await c.readContract({ address: e.pool, abi: poolConfigAbi, functionName: "getEModeCategoryCollateralBitmap", args: [Number(eModeId)], blockNumber: P });
  }
  const bonusBps = effectiveBonusBps({ reserveConfig, eModeCategory: eModeId, eModeBonus, collateralBitmap, reserveId: BigInt(reserve.id) });

  let twapTick: number | null = null;
  let twapPrice: string | null = null;
  try {
    const [ticks] = await c.readContract({ address: UNISWAP_POOL, abi: v3PoolAbi, functionName: "observe", args: [[TWAP_WINDOW_SEC, 0]], blockNumber: B });
    twapTick = meanTick(ticks[0]!, ticks[1]!, TWAP_WINDOW_SEC);
    twapPrice = priceAtTick(twapTick).toString();
  } catch {
    // Not enough observation history at this block: the source is simply absent.
  }

  const { borrows, collaterals } = countUserAssets(userConfig);
  return {
    ...e,
    timestamp: Number(block.timestamp),
    debtDecimals: Number(debtDecimals),
    protocolFee: findProtocolFee(receipt.logs, e.logIndex, e.aToken, e.user, treasury).toString(),
    lidoRate: lidoRate.toString(),
    twapTick,
    twapPrice,
    chainlinkStEthEth: feed.toString(),
    oracleCollateral: oc.toString(),
    oracleDebt: od.toString(),
    oracleWeth: ow.toString(),
    preOracleCollateral: poc.toString(),
    preOracleWeth: pow.toString(),
    preCollateralBalance: a.toString(),
    preDebtBalance: d.toString(),
    totalCollateralBase: acct[0].toString(),
    totalDebtBase: acct[1].toString(),
    ltBps: acct[3].toString(),
    bonusBps: bonusBps.toString(),
    eModeId: Number(eModeId),
    borrows,
    collaterals,
  };
}
