/**
 * Read-only chain access shared by verify-onchain.mjs and fetch-incident.ts.
 * Addresses here are inputs to be checked, not trusted: verify-onchain.mjs
 * re-derives pools and oracles from Aave's on-chain registry.
 */
import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hash, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

export const WSTETH: Address = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
export const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const ADDRESSES_PROVIDER_REGISTRY: Address = "0xbaA999AC55EAce41CcAE355c77809e68Bb345170";
export const CORE_PROVIDER: Address = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
export const UNISWAP_V3_FACTORY: Address = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
/** Checked by verify-onchain.mjs against the feed's description(). */
export const CHAINLINK_STETH_ETH_FEED: Address = "0x86392dC19c0b719886221c78AB11eb8Cf5c52812";
export const SUBMISSION_TX: Hash = "0xfbafeaa8c58dd6d79f88cdf5604bd25760964bc8fc0e834fe381bb1d96d3db95";
export const EXECUTION_TX: Hash = "0x32c64151469cf2202cbc9581139c6de7b34dae2012eba9daf49311265dfe5a1e";
/** Blocks scanned either side of the execution block when looking for incident logs. */
export const SCAN_BEFORE = 300n;
export const SCAN_AFTER = 3600n;

export const providerAbi = parseAbi([
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
  "function getPoolConfigurator() view returns (address)",
  "function getMarketId() view returns (string)",
]);
export const registryAbi = parseAbi(["function getAddressesProvidersList() view returns (address[])"]);
export const poolAbi = parseAbi([
  "struct CollateralConfig { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; }",
  "function getUserEMode(address user) view returns (uint256)",
  "function getEModeCategoryCollateralConfig(uint8 id) view returns (CollateralConfig)",
  "function getEModeCategoryLabel(uint8 id) view returns (string)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);
export const oracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);
export const wstEthAbi = parseAbi(["function stEthPerToken() view returns (uint256)"]);
export const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
export const v3PoolAbi = parseAbi([
  "function liquidity() view returns (uint128)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export const aTokenAbi = parseAbi(["function RESERVE_TREASURY_ADDRESS() view returns (address)"]);
export const reserveAbi = parseAbi(["function getReserveAToken(address asset) view returns (address)"]);
const LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const liquidationCall = parseAbiItem(
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
);
export const borrowCapChanged = parseAbiItem("event BorrowCapChanged(address indexed asset, uint256 oldBorrowCap, uint256 newBorrowCap)");

/** RPC URLs embed API keys, and viem puts the URL in error messages. */
export function safeMessage(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  let text = err?.shortMessage ?? err?.message ?? String(e);
  for (const secret of [process.env.MAINNET_RPC, process.env.ETHERSCAN_API_KEY]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function exitSafely(e: unknown): never {
  console.error(`error: ${safeMessage(e)}`);
  process.exit(1);
}

const MIN_REQUEST_GAP_MS = 80;
let nextSlot = 0;

/** Spaces all RPC requests out, so parallel reads do not trip provider rate limits. */
const throttledFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return fetch(input, init);
}) as typeof fetch;

export function makeClient(): PublicClient {
  const url = process.env.MAINNET_RPC;
  if (!url) throw new Error("MAINNET_RPC is not set. Copy .env.example to .env and fill it in.");
  process.on("uncaughtException", exitSafely);
  process.on("unhandledRejection", exitSafely);
  return createPublicClient({
    chain: mainnet,
    transport: http(url, { retryCount: 8, retryDelay: 1500, timeout: 30_000, fetchFn: throttledFetch }),
  }) as PublicClient;
}

/** Walks a block range, halving the chunk when the RPC refuses it. Throws rather than skip a range. */
export async function scanRange<T>(from: bigint, to: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>, startStep = 500n): Promise<T[]> {
  const out: T[] = [];
  let step = startStep;
  for (let s = from; s <= to; ) {
    const e = s + step - 1n > to ? to : s + step - 1n;
    try {
      out.push(...(await fetch(s, e)));
      s = e + 1n;
    } catch (err) {
      if (step <= 8n) throw new Error(`log scan failed at blocks ${s}-${e}: ${(err as Error).message}`);
      step /= 2n;
    }
  }
  return out;
}

export interface Market {
  name: string;
  provider: Address;
  pool: Address;
  oracle: Address;
  configurator: Address;
}

/** Resolves every Aave v3 market from the on-chain registry at a block. */
export async function resolveMarkets(c: PublicClient, blockNumber: bigint): Promise<Market[]> {
  const providers = await c.readContract({ address: ADDRESSES_PROVIDER_REGISTRY, abi: registryAbi, functionName: "getAddressesProvidersList", blockNumber });
  const out: Market[] = [];
  for (const provider of providers) {
    const read = (functionName: "getPool" | "getPriceOracle" | "getPoolConfigurator" | "getMarketId") =>
      c.readContract({ address: provider, abi: providerAbi, functionName, blockNumber } as never) as Promise<string>;
    out.push({
      name: await read("getMarketId"),
      provider,
      pool: (await read("getPool")) as Address,
      oracle: (await read("getPriceOracle")) as Address,
      configurator: (await read("getPoolConfigurator")) as Address,
    });
  }
  return out;
}

export interface Liquidation {
  market: string;
  pool: Address;
  txHash: Hash;
  blockNumber: number;
  blockTimestamp: number;
  transactionIndex: number;
  logIndex: number;
  user: Address;
  liquidator: Address;
  builder: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: string;
  collateralSeized: string;
  receiveAToken: boolean;
  /** Aave oracle prices in the base currency, read at the end of the liquidation block. */
  oracleCollateralPrice: string;
  oracleDebtPrice: string;
  stEthPerToken: string;
  /**
   * Collateral moved from the user to the Aave treasury as the liquidation protocol fee,
   * read from the aToken Transfer log. liquidatedCollateralAmount does not include it.
   */
  protocolFeeCollateral: string;
  /** Health factor at the block before the incident's execution block. */
  preGlitchHealthFactor: string;
  /** State at block - 1. */
  pre: { eModeId: number; healthFactor: string; totalCollateralBase: string; totalDebtBase: string; liquidationThresholdBps: string };
}

/** Pulls and enriches every wstETH-collateral liquidation in a range, for the given markets. */
export async function collectLiquidations(c: PublicClient, markets: Market[], from: bigint, to: bigint, preGlitchBlock: bigint): Promise<Liquidation[]> {
  const byPool = new Map(markets.map((m) => [m.pool.toLowerCase(), m]));
  const logs = await scanRange(from, to, (fromBlock, toBlock) =>
    c.getLogs({ address: markets.map((m) => m.pool), event: liquidationCall, args: { collateralAsset: WSTETH }, fromBlock, toBlock }),
  );
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, f: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, f());
    return memo.get(key) as Promise<T>;
  };

  const out: Liquidation[] = [];
  for (const l of logs) {
    const m = byPool.get(l.address.toLowerCase());
    const a = l.args;
    if (!m || !a.user || !a.debtAsset || !a.collateralAsset || a.debtToCover === undefined || a.liquidatedCollateralAmount === undefined || !a.liquidator) {
      throw new Error(`undecodable liquidation log in ${l.transactionHash}`);
    }
    const B = l.blockNumber;
    const user = a.user;
    const debtAsset = a.debtAsset;
    const block = await once(`b${B}`, () => c.getBlock({ blockNumber: B }));
    const price = (asset: Address) =>
      once(`p${m.oracle}${asset}${B}`, () => c.readContract({ address: m.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [asset], blockNumber: B }));
    const rate = await once(`r${B}`, () => c.readContract({ address: WSTETH, abi: wstEthAbi, functionName: "stEthPerToken", blockNumber: B }));
    const eModeId = await once(`e${m.pool}${user}${B}`, () => c.readContract({ address: m.pool, abi: poolAbi, functionName: "getUserEMode", args: [user], blockNumber: B - 1n }));
    const acct = await once(`a${m.pool}${user}${B}`, () => c.readContract({ address: m.pool, abi: poolAbi, functionName: "getUserAccountData", args: [user], blockNumber: B - 1n }));
    const preGlitch = await once(`g${m.pool}${user}`, () =>
      c.readContract({ address: m.pool, abi: poolAbi, functionName: "getUserAccountData", args: [user], blockNumber: preGlitchBlock }));
    const aToken = await once(`t${m.pool}`, () => c.readContract({ address: m.pool, abi: reserveAbi, functionName: "getReserveAToken", args: [WSTETH], blockNumber: B }));
    const treasury = await once(`y${aToken}`, () => c.readContract({ address: aToken, abi: aTokenAbi, functionName: "RESERVE_TREASURY_ADDRESS", blockNumber: B }));
    const receipt = await once(`x${l.transactionHash}`, () => c.getTransactionReceipt({ hash: l.transactionHash }));
    out.push({
      market: m.name,
      pool: m.pool,
      txHash: l.transactionHash,
      blockNumber: Number(B),
      blockTimestamp: Number(block.timestamp),
      transactionIndex: l.transactionIndex,
      logIndex: l.logIndex,
      user,
      liquidator: a.liquidator,
      builder: block.miner,
      collateralAsset: a.collateralAsset,
      debtAsset,
      debtToCover: a.debtToCover.toString(),
      collateralSeized: a.liquidatedCollateralAmount.toString(),
      receiveAToken: a.receiveAToken ?? false,
      oracleCollateralPrice: (await price(WSTETH)).toString(),
      oracleDebtPrice: (await price(debtAsset)).toString(),
      stEthPerToken: rate.toString(),
      protocolFeeCollateral: findProtocolFee(receipt.logs, l.logIndex, aToken, user, treasury).toString(),
      preGlitchHealthFactor: preGlitch[5].toString(),
      pre: {
        eModeId: Number(eModeId),
        healthFactor: acct[5].toString(),
        totalCollateralBase: acct[0].toString(),
        totalDebtBase: acct[1].toString(),
        liquidationThresholdBps: acct[3].toString(),
      },
    });
  }
  return out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
}

type RawLog = { address: string; topics: readonly string[]; data: string; logIndex: number };

/**
 * Finds the fee transfer belonging to one liquidation: the aToken Transfer from the user to
 * the treasury after the previous LiquidationCall in the tx and before this one. Pure.
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

const WAD = 10n ** 18n;

export interface Summary {
  count: number;
  users: number;
  collateralSeized: bigint;
  debtCovered: bigint;
  /** Sum of C * stEthPerToken - X. Rough check only: 1 stETH is treated as 1 ETH. It is not a verdict. */
  netLossAtLidoRate: bigint;
}

/** Aggregates liquidations whose debt is WETH. Pure. */
export function summarize(liqs: Pick<Liquidation, "user" | "debtToCover" | "collateralSeized" | "stEthPerToken">[]): Summary {
  let collateralSeized = 0n;
  let debtCovered = 0n;
  let netLossAtLidoRate = 0n;
  for (const l of liqs) {
    const C = BigInt(l.collateralSeized);
    const X = BigInt(l.debtToCover);
    collateralSeized += C;
    debtCovered += X;
    netLossAtLidoRate += (C * BigInt(l.stEthPerToken)) / WAD - X;
  }
  return { count: liqs.length, users: new Set(liqs.map((l) => l.user.toLowerCase())).size, collateralSeized, debtCovered, netLossAtLidoRate };
}

/** Formats an 18-decimal integer with fixed decimals, truncating. Pure. */
export function fmt18(v: bigint, decimals = 4): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % WAD).toString().padStart(18, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${a / WAD}${decimals ? "." + frac : ""}`;
}
