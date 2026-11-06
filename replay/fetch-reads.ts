/**
 * Reads archive state for the incident and selects the control set, caching both:
 *   replay/data/incident-reads.json   the 47 WETH-debt incident liquidations
 *   replay/data/control-reads.json    50 calm-period liquidations
 *
 * Control rule. Walking back from the incident, take wstETH-collateral liquidations on
 * Core and Prime within CONTROL_LOOKBACK_BLOCKS, skipping any UTC day with
 * CASCADE_DAY_THRESHOLD or more of them (a proxy for a market cascade), and skipping
 * wstETH-debt events, whose debt price is the asset under test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseAbi, type Address, type Hash } from "viem";
import { EXECUTION_TX, WETH, WSTETH, aTokenAbi, makeClient, reserveAbi, resolveMarkets, safeMessage, type Liquidation, type Market } from "./onchain";
import { readEvent, type EventInput, type EventReads } from "./reads";

export const CONTROL_SIZE = 50;
export const CASCADE_DAY_THRESHOLD = 5;
export const CONTROL_LOOKBACK_BLOCKS = 2_600_000; // about one year
const LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
const debtTokenAbi = parseAbi(["function getReserveVariableDebtToken(address asset) view returns (address)"]);
const dataDir = join(import.meta.dir, "data");

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  timeStamp: string;
  transactionHash: string;
}

export async function etherscanLogs(address: string, fromBlock: number, toBlock: number, key: string): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let from = fromBlock;
  for (;;) {
    const q = new URLSearchParams({
      chainid: "1", module: "logs", action: "getLogs", fromBlock: String(from), toBlock: String(toBlock), address,
      topic0: LIQUIDATION_TOPIC, topic1: "0x" + WSTETH.slice(2).toLowerCase().padStart(64, "0"), topic0_1_opr: "and", page: "1", offset: "1000", apikey: key,
    });
    const r = (await (await fetch(`https://api.etherscan.io/v2/api?${q}`)).json()) as { result: RawLog[] | string; message: string };
    if (!Array.isArray(r.result)) {
      if (r.message === "No records found") return out;
      throw new Error(`Etherscan logs failed: ${r.message}`);
    }
    out.push(...r.result);
    if (r.result.length < 1000) return out;
    from = Number(r.result[r.result.length - 1]!.blockNumber) + 1;
  }
}

/** Pure selection of the control set, newest first. */
export function selectControl(logs: RawLog[], size: number, cascadeThreshold: number): RawLog[] {
  const day = (l: RawLog) => new Date(Number(l.timeStamp) * 1000).toISOString().slice(0, 10);
  const perDay = new Map<string, number>();
  for (const l of logs) perDay.set(day(l), (perDay.get(day(l)) ?? 0) + 1);

  const wstEthTopic = WSTETH.slice(2).toLowerCase();
  return logs
    .filter((l) => (perDay.get(day(l)) ?? 0) < cascadeThreshold && !l.topics[2]!.endsWith(wstEthTopic))
    .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber) || Number(b.logIndex) - Number(a.logIndex))
    .slice(0, size);
}

async function main() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  const c = makeClient();
  const exec = await c.getTransactionReceipt({ hash: EXECUTION_TX });
  const B = exec.blockNumber;
  const markets = (await resolveMarkets(c, B)).filter((m) => /Aave Ethereum Market|Lido/.test(m.name));

  const tokens = new Map<string, { aToken: Address; treasury: Address }>();
  for (const m of markets) {
    const aToken = await c.readContract({ address: m.pool, abi: reserveAbi, functionName: "getReserveAToken", args: [WSTETH], blockNumber: B });
    const treasury = await c.readContract({ address: aToken, abi: aTokenAbi, functionName: "RESERVE_TREASURY_ADDRESS", blockNumber: B });
    tokens.set(m.pool.toLowerCase(), { aToken, treasury });
  }
  const debtTokens = new Map<string, Address>();
  const debtTokenOf = async (m: Market, asset: Address) => {
    const k = `${m.pool}:${asset}`.toLowerCase();
    if (!debtTokens.has(k)) debtTokens.set(k, await c.readContract({ address: m.pool, abi: debtTokenAbi, functionName: "getReserveVariableDebtToken", args: [asset], blockNumber: B }));
    return debtTokens.get(k)!;
  };

  async function readAll(items: { m: Market; input: Omit<EventInput, "market" | "pool" | "oracle" | "aToken" | "debtToken"> }[]): Promise<EventReads[]> {
    const out: EventReads[] = [];
    for (const { m, input } of items) {
      const t = tokens.get(m.pool.toLowerCase())!;
      const debtToken = await debtTokenOf(m, input.debtAsset);
      out.push(await readEvent(c, { ...input, market: m.name, pool: m.pool, oracle: m.oracle, aToken: t.aToken, debtToken }, t.treasury));
      process.stdout.write(".");
    }
    console.log();
    return out;
  }

  const incident = JSON.parse(readFileSync(join(dataDir, "incident-2026-03-10.json"), "utf8")) as { liquidations: Liquidation[] };
  const marketOf = (pool: string) => markets.find((m) => m.pool.toLowerCase() === pool.toLowerCase())!;
  const incidentItems = incident.liquidations
    .filter((l) => l.debtAsset.toLowerCase() === WETH.toLowerCase())
    .map((l) => ({
      m: marketOf(l.pool),
      input: { txHash: l.txHash, blockNumber: l.blockNumber, logIndex: l.logIndex, user: l.user, debtAsset: l.debtAsset, debtToCover: l.debtToCover, collateralEvent: l.collateralSeized },
    }));
  console.log(`reading ${incidentItems.length} incident events`);
  writeFileSync(join(dataDir, "incident-reads.json"), JSON.stringify(await readAll(incidentItems), null, 1) + "\n");

  const end = Number(B) - 1;
  const start = end - CONTROL_LOOKBACK_BLOCKS;
  const logs: RawLog[] = [];
  for (const m of markets) logs.push(...(await etherscanLogs(m.pool, start, end, key)));
  const chosen = selectControl(logs, CONTROL_SIZE, CASCADE_DAY_THRESHOLD);
  if (chosen.length < CONTROL_SIZE) console.log(`WARNING: only ${chosen.length} control events found`);

  const controlItems = chosen.map((l) => {
    const words = l.data.slice(2).match(/.{64}/g)!;
    return {
      m: marketOf(l.address),
      input: {
        txHash: l.transactionHash as Hash,
        blockNumber: Number(l.blockNumber),
        logIndex: Number(l.logIndex),
        user: getAddress("0x" + l.topics[3]!.slice(26)),
        debtAsset: getAddress("0x" + l.topics[2]!.slice(26)),
        debtToCover: BigInt("0x" + words[0]!).toString(),
        collateralEvent: BigInt("0x" + words[1]!).toString(),
      },
    };
  });
  console.log(`reading ${controlItems.length} control events from ${logs.length} candidates`);
  writeFileSync(join(dataDir, "control-reads.json"), JSON.stringify(await readAll(controlItems), null, 1) + "\n");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${safeMessage(e)}`);
    process.exit(1);
  });
}
