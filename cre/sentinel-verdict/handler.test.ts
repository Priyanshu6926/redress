/**
 * Every capability is mocked with the SDK's EvmMock, HttpActionsMock and test runtime.
 * Mock responses are rebuilt from real cached incident reads, so these are golden tests:
 * the workflow must reach the exact redress the audited offline replay reached.
 */
import { describe, expect } from "bun:test";
import { bigintToBytes, bytesToHex, getNetwork, hexToBytes, protoBigIntToBigint } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, pad, parseAbi, toHex,
  type Address, type Hex,
} from "viem";
import config from "./config.fork.json";
import forkConfig from "./config.fork.json";
import sepoliaConfig from "./config.sepolia.json";
import incident from "../../replay/data/incident-reads.json";
import adapters from "../../replay/data/incident-adapters.json";
import offchainFile from "../../replay/data/offchain-prices.json";
import results from "../../replay/out/results-default.json";
import { multicallAbi, onLiquidation, ratioE18, type Config } from "./handler";
import { LIQUIDATION_TOPIC } from "./position";
import { REPORT_PARAMS } from "./report";
import { DEMO_ENGINE, HOOK_SOURCE_NAME } from "./v4hook";

const cfg = config as unknown as Config;
const selector = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.readChain })!.chainSelector.selector;
const TREASURY: Address = "0x00000000000000000000000000000000000000fe";
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const VAULT_TX = `0x${"ab".repeat(32)}` as Hex;
const COLLATERAL_ID = 9;
const LIQUIDATOR: Address = "0x00000000000000000000000000000000000000aa";
const eventOf = (r: { txHash: string; logIndex: number }) => adapters.events.find((e) => e.txHash === r.txHash && e.logIndex === r.logIndex)!;
const adapterOf = (r: { txHash: string; logIndex: number }) => eventOf(r).oracleAdapter as Address;
const builderOf = (r: { txHash: string; logIndex: number }) => eventOf(r).builder as Address;

/** Replies carry the protobuf message form of a BigInt, with raw bytes. */
const pbBlock = (n: number) => ({ absVal: bigintToBytes(BigInt(n)), sign: 1n });

type Read = (typeof incident)[number];

const abi = parseAbi([
  "struct CollateralConfig { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; }",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserEMode(address) view returns (uint256)",
  "function getUserConfiguration(address) view returns (uint256)",
  "function getConfiguration(address) view returns (uint256)",
  "function getEModeCategoryCollateralConfig(uint8) view returns (CollateralConfig)",
  "function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)",
  "function balanceOf(address) view returns (uint256)",
  "function RESERVE_TREASURY_ADDRESS() view returns (address)",
  "function getAssetPrice(address) view returns (uint256)",
  "function getSourceOfAsset(address) view returns (address)",
  "function getCurrentBlockCoinbase() view returns (address)",
  "function stEthPerToken() view returns (uint256)",
  "function latestAnswer() view returns (int256)",
  "function observe(uint32[]) view returns (int56[], uint160[])",
]);

/** getReserveData returns a 15-word struct: `id` is the only field the handler uses. */
const RESERVE_DATA_SELECTOR = "0x35ea6a75";
function reserveData(): Hex {
  const words = Array.from({ length: 15 }, (_, i) => (i === 7 ? BigInt(COLLATERAL_ID) : 0n));
  return `0x${words.map((w) => w.toString(16).padStart(64, "0")).join("")}`;
}

/** User configuration bitmap with the position's asset counts. */
function userConfig(r: Read): bigint {
  let v = 0n;
  for (let i = 0; i < r.borrows; i++) v |= 1n << BigInt(2 * i);
  for (let i = 0; i < r.collaterals; i++) v |= 1n << BigInt(2 * i + 1);
  return v;
}

const logOf = (address: string, topics: Hex[], data: Hex, index: number, txHash: Hex, block: number) => ({
  address: hexToBytes(address), topics: topics.map(hexToBytes), data: hexToBytes(data), index,
  txHash: hexToBytes(txHash), blockNumber: pbBlock(block), blockHash: new Uint8Array(32), eventSig: new Uint8Array(32), txIndex: 0, removed: false,
});

function liquidationLog(r: Read) {
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bool" }],
    [BigInt(r.debtToCover), BigInt(r.collateralEvent), "0x00000000000000000000000000000000000000aa", false],
  );
  return logOf(r.pool, [LIQUIDATION_TOPIC as Hex, pad(cfg.wstEth), pad(r.debtAsset as Hex), pad(r.user as Hex)], data, r.logIndex, r.txHash as Hex, r.blockNumber);
}

function feeLog(r: Read) {
  return logOf(r.aToken, [TRANSFER, pad(r.user as Hex), pad(TREASURY)], toHex(BigInt(r.protocolFee), { size: 32 }), r.logIndex - 1, r.txHash as Hex, r.blockNumber);
}

interface Seen {
  blocks: bigint[];
  report?: Hex;
}

/** Answers aggregate3 by target and selector, from one cached read, at the expected block. */
function respond(r: Read, target: string, data: Hex, block: bigint): Hex {
  if (data.startsWith(RESERVE_DATA_SELECTOR)) return reserveData();
  const call = decodeFunctionData({ abi, data });
  const isPre = block === BigInt(r.blockNumber) - 1n;
  const out = (result: unknown) => encodeFunctionResult({ abi, functionName: call.functionName, result } as never);
  const zero = 0n;
  switch (call.functionName) {
    case "getUserAccountData":
      return out([BigInt(r.totalCollateralBase), BigInt(r.totalDebtBase), zero, BigInt(r.ltBps), zero, zero]);
    case "getUserEMode": return out(BigInt(r.eModeId));
    case "getUserConfiguration": return out(userConfig(r));
    case "getConfiguration": return out((BigInt(r.bonusBps) + 10_000n) << 32n);
    case "getEModeCategoryCollateralConfig": return out({ ltv: 9000, liquidationThreshold: 9500, liquidationBonus: Number(r.bonusBps) + 10_000 });
    case "getEModeCategoryCollateralBitmap": return out(1n << BigInt(COLLATERAL_ID));
    case "balanceOf": return out(target.toLowerCase() === r.aToken.toLowerCase() ? BigInt(r.preCollateralBalance) : BigInt(r.preDebtBalance));
    case "RESERVE_TREASURY_ADDRESS": return out(TREASURY);
    case "getAssetPrice": {
      const weth = (call.args![0] as string).toLowerCase() === cfg.weth.toLowerCase();
      return out(BigInt(weth ? (isPre ? r.preOracleWeth : r.oracleWeth) : (isPre ? r.preOracleCollateral : r.oracleCollateral)));
    }
    case "getSourceOfAsset": return out(adapterOf(r));
    case "getCurrentBlockCoinbase": return out(builderOf(r));
    case "stEthPerToken": return out(BigInt(r.lidoRate));
    case "latestAnswer": return out(BigInt(r.chainlinkStEthEth));
    case "observe": return out([[0n, BigInt(r.twapTick!) * BigInt(cfg.twapWindowSec)], [0n, 0n]]);
    default: throw new Error(`unmocked read ${data.slice(0, 10)}`);
  }
}

function install(r: Read, peers: Read[] = [], offchain: { body?: string; status?: number } = {}): Seen {
  const seen: Seen = { blocks: [] };
  const evm = EvmMock.testInstance(selector);

  evm.callContract = (input) => {
    const block = protoBigIntToBigint(input.blockNumber!);
    seen.blocks.push(block);
    const { args } = decodeFunctionData({ abi: multicallAbi, data: bytesToHex(input.call!.data) });
    const calls = args![0] as readonly { target: string; callData: Hex }[];
    const encoded = encodeFunctionResult({
      abi: multicallAbi,
      functionName: "aggregate3",
      result: calls.map((c) => ({ success: true, returnData: respond(r, c.target, c.callData, block) })),
    });
    return { data: hexToBytes(encoded) } as never;
  };
  evm.headerByNumber = () => ({ header: { timestamp: BigInt(r.timestamp), blockNumber: pbBlock(r.blockNumber), hash: new Uint8Array(32), parentHash: new Uint8Array(32) } }) as never;
  evm.getTransactionReceipt = (input) => {
    const hash = bytesToHex(input.hash);
    const owners = [r, ...peers].filter((x) => x.txHash.toLowerCase() === hash.toLowerCase());
    return { receipt: { logs: owners.flatMap((x) => [feeLog(x), liquidationLog(x)]) } } as never;
  };
  evm.filterLogs = () => ({ logs: [...peers, r].map(liquidationLog) }) as never;
  evm.writeReport = (input) => {
    seen.report = bytesToHex(input.report!.rawReport);
    return { txStatus: 2, txHash: hexToBytes(VAULT_TX) } as never;
  };

  const http = HttpActionsMock.testInstance();
  http.sendRequest = () => ({
    statusCode: offchain.status ?? 200,
    headers: {},
    body: new TextEncoder().encode(offchain.body ?? JSON.stringify(offchainFile)),
  }) as never;
  return seen;
}

function run(r: Read, configOverride: Partial<Config> = {}) {
  const runtime = newTestRuntime<Config>(null, {}, { ...cfg, ...configOverride });
  return JSON.parse(onLiquidation(runtime, liquidationLog(r) as never));
}

const rowFor = (r: Read) => results.incident.find((x) => x.txHash === r.txHash && x.logIndex === r.logIndex)!;
const decodeReport = (hex: Hex) => decodeAbiParameters(REPORT_PARAMS, `0x${hex.slice(2 + 109 * 2)}` as Hex)[0];

const first = incident[0]!;
const nonEMode = incident.find((r) => r.eModeId === 0)!;
const multiAsset = incident.find((r) => r.borrows !== 1 || r.collaterals !== 1)!;

function sameBlockPair() {
  const seen = new Map<string, Read[]>();
  for (const r of incident) {
    const k = `${r.pool}:${r.user}:${r.blockNumber}`;
    seen.set(k, [...(seen.get(k) ?? []), r]);
  }
  return [...seen.values()].find((g) => g.length > 2)!.sort((a, b) => a.logIndex - b.logIndex);
}

describe("golden: workflow matches the offline replay", () => {
  for (const [name, r] of [["E-Mode position", first], ["non-E-Mode position", nonEMode], ["multi-asset position", multiAsset]] as const) {
    test(name, () => {
      install(r);
      const row = rowFor(r);
      const out = run(r);
      expect(out.redress).toBe(row.redress);
      expect(out.verdict).toBe(row.verdict);
      expect(out.hfWorst).toBe(row.hfWorst);
      expect(out.bandLow).toBe(row.bandLow);
      expect(out.bandHigh).toBe(row.bandHigh);
    });
  }

  test("every incident event", () => {
    for (const r of incident) {
      const peers = incident.filter((p) => p.pool === r.pool && p.user === r.user && p.blockNumber === r.blockNumber && p.logIndex !== r.logIndex);
      install(r, peers);
      expect(run(r).redress).toBe(rowFor(r).redress);
    }
  });

  test("subtracts earlier same-block liquidations of the position", () => {
    const group = sameBlockPair();
    const last = group[group.length - 1]!;
    install(last, group.slice(0, -1));
    const out = run(last);
    expect(out.peers).toBe(group.length - 1);
    expect(out.hfWorst).toBe(rowFor(last).hfWorst);
  });
});

describe("reads", () => {
  test("position reads use block - 1 and prices use block B", () => {
    const seen = install(first);
    run(first);
    const B = BigInt(first.blockNumber);
    expect(seen.blocks).toEqual([B - 1n, B - 1n, B]);
  });

  test("uses the log index from the receipt, not the trigger", () => {
    install(first);
    const runtime = newTestRuntime<Config>(null, {}, cfg);
    const shifted = { ...liquidationLog(first), index: 3 };
    expect(JSON.parse(onLiquidation(runtime, shifted as never)).logIndex).toBe(first.logIndex);
  });
});

describe("report", () => {
  test("carries the position's facts and fits well under the limit", () => {
    const seen = install(nonEMode);
    run(nonEMode);
    const report = decodeReport(seen.report!);
    const row = rowFor(nonEMode);
    expect(report.liquidationTx).toBe(nonEMode.txHash as Hex);
    expect(report.logIndex).toBe(nonEMode.logIndex);
    expect(report.user).toBe(nonEMode.user as Address);
    expect(report.liquidationBonusBps).toBe(600n);
    expect(report.redress).toBe(BigInt(row.redress));
    expect(report.sourceCount).toBe(3);
    expect(report.evidenceHash).toBe(row.evidenceHash as Hex);
    expect((seen.report!.length - 2) / 2).toBeLessThan(1024);
  });
});

describe("accountability fields", () => {
  test("carries the adapter, liquidator and coinbase read for the event", () => {
    const seen = install(first);
    run(first);
    const report = decodeReport(seen.report!);
    expect(report.oracleAdapter.toLowerCase()).toBe(adapterOf(first).toLowerCase());
    expect(report.liquidator.toLowerCase()).toBe(LIQUIDATOR);
    expect(report.builder.toLowerCase()).toBe(builderOf(first).toLowerCase());
  });
});

describe("handler filter", () => {
  test("skips other pools without reading anything", () => {
    const seen = install(first);
    const runtime = newTestRuntime<Config>(null, {}, cfg);
    const other = liquidationLog({ ...first, pool: "0x00000000000000000000000000000000000000dd" });
    expect(onLiquidation(runtime, other as never)).toBe("skipped");
    expect(seen.blocks).toEqual([]);
    expect(seen.report).toBeUndefined();
  });

  test("skips other debt assets", () => {
    const seen = install(first);
    const runtime = newTestRuntime<Config>(null, {}, cfg);
    const other = liquidationLog({ ...first, debtAsset: "0x00000000000000000000000000000000000000dd" });
    expect(onLiquidation(runtime, other as never)).toBe("skipped");
    expect(seen.blocks).toEqual([]);
    expect(seen.report).toBeUndefined();
  });
});

describe("failure", () => {
  test("off-chain outage leaves two sources, so INCONCLUSIVE pays nothing", () => {
    const seen = install(first, [], { status: 503 });
    const out = run(first);
    expect(out.verdict).toBe("INCONCLUSIVE");
    expect(out.redress).toBe("0");
    expect(decodeReport(seen.report!).verdict).toBe(4);
  });

  test("offchain mode none uses on-chain sources only", () => {
    install(first);
    expect(run(first, { offchain: { ...cfg.offchain, mode: "none" } }).verdict).toBe("INCONCLUSIVE");
  });

  test("a failed write is an error, never a silent success", () => {
    install(first);
    EvmMock.testInstance(selector).writeReport = () => ({ txStatus: 1, errorMessage: "reverted" }) as never;
    expect(() => run(first)).toThrow("report write failed");
  });
});

describe("v4Hook demo source", () => {
  const sepolia = getNetwork({ chainFamily: "evm", chainSelectorName: "ethereum-testnet-sepolia" })!.chainSelector.selector;
  const hookAddress: Address = "0x00000000000000000000000000000000000010c0";
  const zero: Address = "0x0000000000000000000000000000000000000000";
  const v4Hook = {
    type: "v4Hook", chain: "ethereum-testnet-sepolia", hook: hookAddress,
    poolKey: { currency0: zero, currency1: zero, fee: 3000, tickSpacing: 60, hooks: hookAddress },
    windowSec: 1800, minObservations: 5, maxAgeSec: 3600, synthetic: true,
  } as const;
  const demo: Partial<Config> = { v4Hook, dryRun: true, engine: { ...cfg.engine, name: DEMO_ENGINE } };
  const NOW = 2_000_000_000n;
  const bandWord = (tick: number, count: number, age: bigint) =>
    encodeAbiParameters(
      [{ type: "int24" }, { type: "int24" }, { type: "int24" }, { type: "uint32" }, { type: "uint32" }, { type: "uint32" }],
      [tick, tick - 50, tick + 50, count, 1800, Number(NOW - age)],
    );

  function installHook(band: Hex | null) {
    EvmMock.testInstance(sepolia).callContract = () => ({
      data: hexToBytes(encodeFunctionResult({
        abi: multicallAbi,
        functionName: "aggregate3",
        result: [
          { success: band !== null, returnData: band ?? "0x" },
          { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [NOW]) },
        ],
      })),
    }) as never;
  }

  test("a fresh band joins the sources and nothing is written", () => {
    const seen = install(first);
    installHook(bandWord(2052, 7, 60n));
    const out = run(first, demo);
    expect(out.synthetic).toBe(true);
    expect(out.written).toBe(false);
    expect(out.sources.some((s: string) => s.startsWith(HOOK_SOURCE_NAME))).toBe(true);
    expect(seen.report).toBeUndefined();
  });

  test("too few observations drops the source", () => {
    install(first);
    installHook(bandWord(2052, 4, 60n));
    expect(run(first, demo).sources.some((s: string) => s.startsWith(HOOK_SOURCE_NAME))).toBe(false);
  });

  test("an old band drops the source", () => {
    install(first);
    installHook(bandWord(2052, 7, 3601n));
    expect(run(first, demo).sources.some((s: string) => s.startsWith(HOOK_SOURCE_NAME))).toBe(false);
  });

  test("a reverting hook drops the source rather than failing the verdict", () => {
    install(first);
    installHook(null);
    expect(run(first, demo).sources.some((s: string) => s.startsWith(HOOK_SOURCE_NAME))).toBe(false);
  });

  test("a replay config with a hook source is refused", () => {
    install(first);
    expect(() => run(first, { v4Hook })).toThrow("only allowed in the demo-v4hook config");
  });

  test("the demo config must be a dry run", () => {
    install(first);
    expect(() => run(first, { ...demo, dryRun: false })).toThrow("must be a dry run");
  });

  test("the incident configs carry no hook source", () => {
    expect(forkConfig).not.toHaveProperty("v4Hook");
    expect(sepoliaConfig).not.toHaveProperty("v4Hook");
    expect(sepoliaConfig).not.toHaveProperty("dryRun");
  });
});

describe("live mode", () => {
  test("reads DefiLlama at the block timestamp", () => {
    const body = JSON.stringify({
      coins: {
        [`ethereum:${cfg.wstEth}`]: { price: 2532.39, timestamp: first.timestamp + 40 },
        [`ethereum:${cfg.weth}`]: { price: 2064.6, timestamp: first.timestamp - 70 },
      },
    });
    install(first, [], { body });
    const out = run(first, { offchain: { ...cfg.offchain, mode: "live" } });
    expect(out.sources).toContain(`S3 defillama=${ratioE18(2532.39, 2064.6)}`);
  });
});
