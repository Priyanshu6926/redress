/**
 * Archive reads for one liquidation, plus the pure conversions that turn them into
 * engine inputs. Reads are cached in replay/data so the replay runs without an RPC.
 */
import { parseAbi, type Address, type Hash, type PublicClient } from "viem";
import { effectiveBonusBps } from "../cre/sentinel-verdict/bonus";
import { countUserAssets, findProtocolFee, meanTick, priceAtTick, type EventFacts } from "../cre/sentinel-verdict/position";
import { CHAINLINK_STETH_ETH_FEED, WETH, WSTETH, erc20Abi, oracleAbi, poolAbi, v3PoolAbi, wstEthAbi } from "./onchain";

/** Deepest wstETH/WETH pool, chosen in replay/data/verification-report.txt. token0 is wstETH. */
export const UNISWAP_POOL: Address = "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa";
export const TWAP_WINDOW_SEC = 1800;

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

export { countUserAssets, meanTick, priceAtTick, sqrtRatioAtTick } from "../cre/sentinel-verdict/position";

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
/** Everything read from chain for one liquidation. */
export interface EventReads extends EventInput, EventFacts {
  twapTick: number | null;
  chainlinkStEthEth: string;
  eModeId: number;
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
