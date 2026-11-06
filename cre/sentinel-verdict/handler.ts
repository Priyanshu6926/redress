/**
 * The sentinel-verdict handler. Reads a liquidation's facts through CRE capabilities, runs
 * the shared engine, and writes one report to the vault. All judgement is in position.ts
 * and verdict.ts; this file only moves data.
 */
import {
  ConsensusAggregationByFields, EVMClient, HTTPClient, TxStatus, bytesToHex, encodeCallMsg, getNetwork, blockNumber as toBlock,
  hexToBase64, median, prepareReportRequest, protoBigIntToBigint,
  type EVMLog, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress,
  type Abi, type Address, type Hex,
} from "viem";
import { effectiveBonusBps } from "./bonus";
import {
  LIQUIDATION_TOPIC, assess, collateralGross, countUserAssets, evidenceHash, findProtocolFee, meanTick, nearestPerSource, priceAtTick, to18,
  type EventFacts, type OffchainPrice, type RawLog,
} from "./position";
import { encodeReport } from "./report";
import { assertHookAllowed, hookSource, type HookBand, type V4HookConfig } from "./v4hook";
import { INCONCLUSIVE, VerdictType, type EngineConfig, type Liquidation, type PriceSource } from "./verdict";

export interface Market {
  name: string;
  pool: Address;
  oracle: Address;
  aToken: Address;
  debtToken: Address;
}

export interface Config {
  readChain: string;
  writeChain: string;
  vault: Address;
  gasLimit: string;
  /** Block confidence for the log trigger. Applies to live triggers only. */
  confidence: "CONFIDENCE_LEVEL_LATEST" | "CONFIDENCE_LEVEL_SAFE" | "CONFIDENCE_LEVEL_FINALIZED";
  wstEth: Address;
  weth: Address;
  multicall3: Address;
  chainlinkStEthEth: Address;
  uniswapPool: Address;
  twapWindowSec: number;
  markets: Market[];
  offchain: { mode: "snapshot" | "live" | "none"; snapshotUrl: string; liveUrl: string };
  engine: { name: string; tauBps: string; muBps: string; epsOutBps: string; epsHBps: string; minSources: number; maxStalenessSec: string };
  /** Demo only: a synthetic v4 pool as an extra source. Never present in a replay config. */
  v4Hook?: V4HookConfig;
  /** Runs the verdict and stops before any report is signed or written. */
  dryRun?: boolean;
}

const poolAbi = parseAbi([
  "struct CollateralConfig { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; }",
  "struct ReserveConfigurationMap { uint256 data; }",
  "struct ReserveDataLegacy { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getUserEMode(address user) view returns (uint256)",
  "function getUserConfiguration(address user) view returns (uint256)",
  "function getConfiguration(address asset) view returns (uint256)",
  "function getReserveData(address asset) view returns (ReserveDataLegacy)",
  "function getEModeCategoryCollateralConfig(uint8 id) view returns (CollateralConfig)",
  "function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function RESERVE_TREASURY_ADDRESS() view returns (address)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256)"]);
const wstEthAbi = parseAbi(["function stEthPerToken() view returns (uint256)"]);
const feedAbi = parseAbi(["function latestAnswer() view returns (int256)"]);
const uniswapAbi = parseAbi(["function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"]);
const hookAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Band { int24 twapTick; int24 minTick; int24 maxTick; uint32 count; uint32 coveredSeconds; uint32 lastObservedAt; }",
  "function getBand(PoolKey key, uint32 window) view returns (Band)",
]);
const clockAbi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);
export const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const liquidationAbi = parseAbi([
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
]);

interface Read {
  target: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  allowFailure?: boolean;
}

function evmClient(chain: string): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: chain });
  if (!network) throw new Error(`unknown chain: ${chain}`);
  return new EVMClient(network.chainSelector.selector);
}

/** One Multicall3 read at a block, or the latest. Decoded values are in the order of `reads`; a failed optional read is undefined. */
function multicall(runtime: Runtime<Config>, client: EVMClient, reads: Read[], block?: bigint): unknown[] {
  const calls = reads.map((r) => ({
    target: r.target,
    allowFailure: r.allowFailure ?? false,
    callData: encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args }),
  }));
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.multicall3,
        data: encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [calls] }),
      }),
      ...(block === undefined ? {} : { blockNumber: toBlock(block) }),
    })
    .result();
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: bytesToHex(reply.data) });
  return results.map((r, i) =>
    r.success ? decodeFunctionResult({ abi: reads[i]!.abi, functionName: reads[i]!.functionName, data: r.returnData }) : undefined,
  );
}

const hexLog = (l: EVMLog | { address: Uint8Array; topics: Uint8Array[]; data: Uint8Array; index: number }): RawLog => ({
  address: bytesToHex(l.address),
  topics: l.topics.map(bytesToHex),
  data: bytesToHex(l.data),
  logIndex: l.index,
});

interface OffchainReply {
  defillamaPrice: bigint;
  defillamaTimestamp: bigint;
  coingeckoPrice: bigint;
  coingeckoTimestamp: bigint;
}

const NO_PRICES: OffchainReply = { defillamaPrice: 0n, defillamaTimestamp: 0n, coingeckoPrice: 0n, coingeckoTimestamp: 0n };

/** wstETH per WETH from two USD prices, matching replay/fetch-offchain.ts. */
export function ratioE18(wstEthUsd: number, wethUsd: number): bigint {
  return BigInt(Math.round((wstEthUsd / wethUsd) * 1e12)) * 10n ** 6n;
}

function fetchOffchain(sender: HTTPSendRequester, args: { cfg: Config; timestamp: number }): OffchainReply {
  const { cfg, timestamp } = args;
  const live = cfg.offchain.mode === "live";
  const url = live ? cfg.offchain.liveUrl.replace("{timestamp}", String(timestamp)) : cfg.offchain.snapshotUrl;
  const response = sender.sendRequest({ url, method: "GET" as const }).result();
  if (response.statusCode !== 200) throw new Error(`off-chain source returned ${response.statusCode}`);
  const body = JSON.parse(new TextDecoder().decode(response.body));

  if (live) {
    const wst = body.coins[`ethereum:${cfg.wstEth}`];
    const weth = body.coins[`ethereum:${cfg.weth}`];
    const older = Math.abs(wst.timestamp - timestamp) >= Math.abs(weth.timestamp - timestamp) ? wst.timestamp : weth.timestamp;
    return { ...NO_PRICES, defillamaPrice: ratioE18(wst.price, weth.price), defillamaTimestamp: BigInt(older) };
  }

  const reply = { ...NO_PRICES };
  for (const p of nearestPerSource(body.prices as OffchainPrice[], timestamp)) {
    if (p.name === "defillama") {
      reply.defillamaPrice = BigInt(p.price);
      reply.defillamaTimestamp = BigInt(p.timestamp);
    } else if (p.name === "coingecko") {
      reply.coingeckoPrice = BigInt(p.price);
      reply.coingeckoTimestamp = BigInt(p.timestamp);
    }
  }
  return reply;
}

/** Off-chain prices with DON consensus. A failed source means fewer sources, never a payout on stale data. */
function offchainPrices(runtime: Runtime<Config>, timestamp: number): OffchainPrice[] {
  const cfg = runtime.config;
  if (cfg.offchain.mode === "none") return [];
  try {
    const r = new HTTPClient()
      .sendRequest(
        runtime,
        fetchOffchain,
        ConsensusAggregationByFields<OffchainReply>({
          defillamaPrice: median<bigint>,
          defillamaTimestamp: median<bigint>,
          coingeckoPrice: median<bigint>,
          coingeckoTimestamp: median<bigint>,
        }),
      )({ cfg, timestamp })
      .result();
    const out: OffchainPrice[] = [];
    if (r.defillamaPrice > 0n) out.push({ name: "defillama", timestamp: Number(r.defillamaTimestamp), price: r.defillamaPrice.toString() });
    if (r.coingeckoPrice > 0n) out.push({ name: "coingecko", timestamp: Number(r.coingeckoTimestamp), price: r.coingeckoPrice.toString() });
    return out;
  } catch (e) {
    runtime.log(`off-chain source unavailable: ${(e as Error).message}`);
    return [];
  }
}

function engineConfig(cfg: Config): EngineConfig {
  const e = cfg.engine;
  return {
    name: e.name,
    tauBps: BigInt(e.tauBps),
    muBps: BigInt(e.muBps),
    epsOutBps: BigInt(e.epsOutBps),
    epsHBps: BigInt(e.epsHBps),
    minSources: e.minSources,
    maxStalenessSec: BigInt(e.maxStalenessSec),
  };
}

/** The real log index and fee for a liquidation, from its transaction's receipt. */
function fromReceipt(logs: RawLog[], log: RawLog, market: Market, user: Address, treasury: Address) {
  const matches = logs.filter((l) => l.topics[0] === LIQUIDATION_TOPIC && l.data === log.data && l.topics[3] === log.topics[3]);
  const match = matches.find((l) => l.logIndex === log.logIndex) ?? matches[0];
  if (!match) throw new Error("liquidation not found in its receipt");
  return { logIndex: match.logIndex, fee: findProtocolFee(logs, match.logIndex, market.aToken, user, treasury) };
}

/** The synthetic hook source, if configured. A failed or stale read means one source fewer. */
function hookSources(runtime: Runtime<Config>, timestamp: number): PriceSource[] {
  const cfg = runtime.config;
  if (!cfg.v4Hook) return [];
  const [band, now] = multicall(runtime, evmClient(cfg.v4Hook.chain), [
    { target: cfg.v4Hook.hook, abi: hookAbi, functionName: "getBand", args: [cfg.v4Hook.poolKey, cfg.v4Hook.windowSec], allowFailure: true },
    { target: cfg.multicall3, abi: clockAbi, functionName: "getCurrentBlockTimestamp" },
  ]) as [HookBand | undefined, bigint];
  const source = hookSource(band, Number(now), timestamp, cfg.v4Hook);
  if (!source) runtime.log("v4 hook source unavailable: no band, too few observations or too old");
  return source ? [source] : [];
}

export function onLiquidation(runtime: Runtime<Config>, log: EVMLog): string {
  const cfg = runtime.config;
  assertHookAllowed(cfg);
  const raw = hexLog(log);
  const decoded = decodeEventLog({ abi: liquidationAbi, data: raw.data as Hex, topics: raw.topics as [Hex, ...Hex[]] });
  const a = decoded.args;
  const market = cfg.markets.find((m) => m.pool.toLowerCase() === raw.address.toLowerCase());

  if (!market || a.collateralAsset.toLowerCase() !== cfg.wstEth.toLowerCase() || a.debtAsset.toLowerCase() !== cfg.weth.toLowerCase()) {
    runtime.log(`skipped: out of scope ${raw.address} ${a.collateralAsset}/${a.debtAsset}`);
    return "skipped";
  }
  if (log.blockNumber === undefined) throw new Error("log has no block number");

  const reader = evmClient(cfg.readChain);
  const B = protoBigIntToBigint(log.blockNumber);
  const P = B - 1n;
  const user = a.user;
  const txHash = bytesToHex(log.txHash);

  const header = reader.headerByNumber(runtime, { blockNumber: toBlock(B) }).result().header;
  if (!header) throw new Error(`no header for block ${B}`);
  const timestamp = Number(header.timestamp);

  const pool = (functionName: string, args: readonly unknown[]): Read => ({ target: market.pool, abi: poolAbi, functionName, args });
  const price = (asset: Address): Read => ({ target: market.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [asset] });
  const [account, eMode, userConfig, reserveConfig, reserve, aBalance, dBalance, treasury, preCollateral, preWeth] = multicall(
    runtime,
    reader,
    [
      pool("getUserAccountData", [user]),
      pool("getUserEMode", [user]),
      pool("getUserConfiguration", [user]),
      pool("getConfiguration", [cfg.wstEth]),
      pool("getReserveData", [cfg.wstEth]),
      { target: market.aToken, abi: tokenAbi, functionName: "balanceOf", args: [user] },
      { target: market.debtToken, abi: tokenAbi, functionName: "balanceOf", args: [user] },
      { target: market.aToken, abi: tokenAbi, functionName: "RESERVE_TREASURY_ADDRESS" },
      price(cfg.wstEth),
      price(cfg.weth),
    ],
    P,
  ) as [readonly bigint[], bigint, bigint, bigint, { id: number }, bigint, bigint, Address, bigint, bigint];

  let eModeBonus = 0n;
  let collateralBitmap = 0n;
  if (eMode !== 0n) {
    const [category, bitmap] = multicall(
      runtime,
      reader,
      [pool("getEModeCategoryCollateralConfig", [Number(eMode)]), pool("getEModeCategoryCollateralBitmap", [Number(eMode)])],
      P,
    ) as [{ liquidationBonus: number }, bigint];
    eModeBonus = BigInt(category.liquidationBonus);
    collateralBitmap = bitmap;
  }

  const [oracleCollateral, oracleWeth, lidoRate, chainlink, observed] = multicall(
    runtime,
    reader,
    [
      price(cfg.wstEth),
      price(cfg.weth),
      { target: cfg.wstEth, abi: wstEthAbi, functionName: "stEthPerToken" },
      { target: cfg.chainlinkStEthEth, abi: feedAbi, functionName: "latestAnswer" },
      { target: cfg.uniswapPool, abi: uniswapAbi, functionName: "observe", args: [[cfg.twapWindowSec, 0]], allowFailure: true },
    ],
    B,
  ) as [bigint, bigint, bigint, bigint, readonly [readonly bigint[], readonly bigint[]] | undefined];

  const receiptLogs = (hash: Uint8Array): RawLog[] => {
    const receipt = reader.getTransactionReceipt(runtime, { hash: hexToBase64(bytesToHex(hash)) }).result().receipt;
    if (!receipt) throw new Error(`no receipt for ${bytesToHex(hash)}`);
    return receipt.logs.map(hexLog);
  };
  const own = fromReceipt(receiptLogs(log.txHash), raw, market, user, treasury);

  const twapTick = observed ? meanTick(observed[0][0]!, observed[0][1]!, cfg.twapWindowSec) : null;
  const facts: EventFacts = {
    blockNumber: Number(B),
    logIndex: own.logIndex,
    timestamp,
    debtToCover: a.debtToCover.toString(),
    collateralEvent: a.liquidatedCollateralAmount.toString(),
    debtDecimals: 18,
    protocolFee: own.fee.toString(),
    lidoRate: lidoRate.toString(),
    twapPrice: twapTick === null ? null : priceAtTick(twapTick).toString(),
    oracleCollateral: oracleCollateral.toString(),
    oracleDebt: oracleWeth.toString(),
    oracleWeth: oracleWeth.toString(),
    preOracleCollateral: preCollateral.toString(),
    preOracleWeth: preWeth.toString(),
    preCollateralBalance: aBalance.toString(),
    preDebtBalance: dBalance.toString(),
    totalCollateralBase: account[0]!.toString(),
    totalDebtBase: account[1]!.toString(),
    ltBps: account[3]!.toString(),
    bonusBps: effectiveBonusBps({ reserveConfig, eModeCategory: eMode, eModeBonus, collateralBitmap, reserveId: BigInt(reserve.id) }).toString(),
    ...countUserAssets(userConfig),
  };

  // Earlier liquidations of this position in this block are not in the block - 1 balances.
  const blockLogs = reader
    .filterLogs(runtime, {
      filterQuery: {
        fromBlock: toBlock(B),
        toBlock: toBlock(B),
        addresses: [hexToBase64(market.pool)],
        topics: [
          { topic: [hexToBase64(LIQUIDATION_TOPIC)] },
          { topic: [hexToBase64(raw.topics[1]!)] },
          { topic: [hexToBase64(raw.topics[2]!)] },
          { topic: [hexToBase64(raw.topics[3]!)] },
        ],
      },
    })
    .result().logs;

  const peers: Liquidation[] = [];
  const receipts = new Map<string, RawLog[]>();
  for (const peer of blockLogs) {
    if (peer.index >= own.logIndex) continue;
    const hash = bytesToHex(peer.txHash);
    if (!receipts.has(hash)) receipts.set(hash, receiptLogs(peer.txHash));
    const rawPeer = hexLog(peer);
    const args = decodeEventLog({ abi: liquidationAbi, data: rawPeer.data as Hex, topics: rawPeer.topics as [Hex, ...Hex[]] }).args;
    const fee = fromReceipt(receipts.get(hash)!, rawPeer, market, user, treasury).fee;
    peers.push({
      block: B,
      logIndex: peer.index,
      collateralSeized: collateralGross({ collateralEvent: args.liquidatedCollateralAmount.toString(), protocolFee: fee.toString() }),
      debtCovered: to18(args.debtToCover, 18),
      oracleCollateralPrice: 0n,
      oracleDebtPrice: 0n,
    });
  }

  const offchain = offchainPrices(runtime, timestamp);
  const engine = engineConfig(cfg);
  const result = assess(facts, peers, engine, offchain, hookSources(runtime, timestamp));
  const { band, outcome } = result;
  const ok = band !== INCONCLUSIVE;

  if (cfg.dryRun) {
    const demo = JSON.stringify({
      synthetic: true,
      written: false,
      config: cfg.engine.name,
      tx: txHash,
      logIndex: own.logIndex,
      verdict: VerdictType[outcome.verdict],
      bandLow: ok ? band.collateral.low.toString() : "0",
      bandHigh: ok ? band.collateral.high.toString() : "0",
      sources: result.sources.map((s) => `${s.name}=${s.price}`),
      redress: result.redress.toString(),
    });
    runtime.log(`REDRESS_DEMO ${demo}`);
    return demo;
  }

  const reportHex = encodeReport({
    liquidationTx: txHash,
    logIndex: own.logIndex,
    blockNumber: B,
    user,
    collateralAsset: cfg.wstEth,
    debtAsset: cfg.weth,
    debtToCover: result.target.debtCovered,
    collateralSeized: result.target.collateralSeized,
    bandLowE18: ok ? band.collateral.low : 0n,
    bandHighE18: ok ? band.collateral.high : 0n,
    debtPriceHighE18: result.debtPrice,
    liquidationBonusBps: BigInt(facts.bonusBps),
    verdict: outcome.verdict,
    sourceCount: ok ? band.collateral.n : 0,
    redress: result.redress,
    evidenceHash: evidenceHash({ txHash, facts, chainlinkStEthEth: chainlink.toString(), sources: result.sources, peers: peers.length, config: engine }),
  });

  const report = runtime.report(prepareReportRequest(reportHex)).result();
  const written = evmClient(cfg.writeChain)
    .writeReport(runtime, { receiver: cfg.vault, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  if (written.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`report write failed: status ${written.txStatus} ${written.errorMessage ?? ""}`);
  }

  const summary = {
    config: cfg.engine.name,
    tx: txHash,
    logIndex: own.logIndex,
    block: Number(B),
    market: market.name,
    user,
    verdict: VerdictType[outcome.verdict],
    hfWorst: outcome.hfWorst.toString(),
    hfBest: outcome.hfBest.toString(),
    bandLow: ok ? band.collateral.low.toString() : "0",
    bandHigh: ok ? band.collateral.high.toString() : "0",
    sources: result.sources.map((s) => `${s.name}=${s.price}`),
    redress: result.redress.toString(),
    peers: peers.length,
    vaultTx: bytesToHex(written.txHash ?? new Uint8Array(32)),
  };
  const line = JSON.stringify(summary);
  runtime.log(`REDRESS_RESULT ${line}`);
  return line;
}
