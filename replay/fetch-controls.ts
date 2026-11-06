/**
 * Builds the wide negative controls from real liquidations, in separate files so the incident
 * data and the original control set never change:
 *   replay/data/control-wide-reads.json     calm and volatility events
 *   replay/data/control-wide-offchain.json  DefiLlama prices for those events
 *
 * Calm uses the original rule: wstETH collateral, no wstETH debt, skipping any UTC day with
 * CASCADE_DAY_THRESHOLD or more liquidations. Volatility takes the day with the most such
 * liquidations, whichever it is: the day is found from the data, not chosen by hand.
 *
 * An event whose reads fail is skipped and counted, never filled in.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseAbi, type Address, type Hash } from "viem";
import { fetchLlama } from "./fetch-offchain";
import { CASCADE_DAY_THRESHOLD, etherscanLogs, selectControl, type RawLog } from "./fetch-reads";
import { EXECUTION_TX, WSTETH, aTokenAbi, makeClient, reserveAbi, resolveMarkets, safeMessage, type Market } from "./onchain";
import { readEvent, type EventReads } from "./reads";

const CALM_SIZE = 220;
const VOLATILITY_SIZE = 60;
const LOOKBACK_BLOCKS = 5_200_000; // about two years
const debtTokenAbi = parseAbi(["function getReserveVariableDebtToken(address asset) view returns (address)"]);
const dataDir = join(import.meta.dir, "data");
const readsPath = join(dataDir, "control-wide-reads.json");

export type LabelledRead = EventReads & { control: "calm" | "volatility" };

const dayOf = (l: RawLog) => new Date(Number(l.timeStamp) * 1000).toISOString().slice(0, 10);

/** The UTC day with the most liquidations. Pure. */
export function busiestDay(logs: readonly RawLog[]): { day: string; count: number } {
  const perDay = new Map<string, number>();
  for (const l of logs) perDay.set(dayOf(l), (perDay.get(dayOf(l)) ?? 0) + 1);
  const [day, count] = [...perDay].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return { day, count };
}

async function main() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  const c = makeClient();
  const B = (await c.getTransactionReceipt({ hash: EXECUTION_TX })).blockNumber;
  const markets = (await resolveMarkets(c, B)).filter((m) => /Aave Ethereum Market|Lido/.test(m.name));

  const tokens = new Map<string, { aToken: Address; treasury: Address }>();
  for (const m of markets) {
    const aToken = await c.readContract({ address: m.pool, abi: reserveAbi, functionName: "getReserveAToken", args: [WSTETH], blockNumber: B });
    const treasury = await c.readContract({ address: aToken, abi: aTokenAbi, functionName: "RESERVE_TREASURY_ADDRESS", blockNumber: B });
    tokens.set(m.pool.toLowerCase(), { aToken, treasury });
  }

  const end = Number(B) - 1;
  const logs: RawLog[] = [];
  for (const m of markets) logs.push(...(await etherscanLogs(m.pool, end - LOOKBACK_BLOCKS, end, key)));
  const noWstEthDebt = logs.filter((l) => !l.topics[2]!.endsWith(WSTETH.slice(2).toLowerCase()));

  const busy = busiestDay(noWstEthDebt);
  console.log(`${logs.length} candidates. Busiest day ${busy.day} with ${busy.count} liquidations.`);
  const calm = selectControl(logs, CALM_SIZE, CASCADE_DAY_THRESHOLD);
  const volatile = noWstEthDebt.filter((l) => dayOf(l) === busy.day).slice(0, VOLATILITY_SIZE);
  console.log(`selected ${calm.length} calm and ${volatile.length} volatility events`);

  const debtTokens = new Map<string, Address>();
  const debtTokenOf = async (m: Market, asset: Address) => {
    const k = `${m.pool}:${asset}`.toLowerCase();
    if (!debtTokens.has(k)) debtTokens.set(k, await c.readContract({ address: m.pool, abi: debtTokenAbi, functionName: "getReserveVariableDebtToken", args: [asset], blockNumber: B }));
    return debtTokens.get(k)!;
  };

  const out: LabelledRead[] = existsSync(readsPath) ? JSON.parse(readFileSync(readsPath, "utf8")) : [];
  const seen = new Set(out.map((r) => `${r.txHash}:${r.logIndex}`));
  let skipped = 0;
  const items = [...calm.map((l) => ["calm", l] as const), ...volatile.map((l) => ["volatility", l] as const)];
  for (const [control, l] of items) {
    if (seen.has(`${l.transactionHash}:${Number(l.logIndex)}`)) continue;
    const m = markets.find((x) => x.pool.toLowerCase() === l.address.toLowerCase())!;
    const t = tokens.get(m.pool.toLowerCase())!;
    const words = l.data.slice(2).match(/.{64}/g)!;
    const debtAsset = getAddress("0x" + l.topics[2]!.slice(26));
    try {
      const read = await readEvent(c, {
        txHash: l.transactionHash as Hash, blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex),
        user: getAddress("0x" + l.topics[3]!.slice(26)), debtAsset,
        debtToCover: BigInt("0x" + words[0]!).toString(), collateralEvent: BigInt("0x" + words[1]!).toString(),
        market: m.name, pool: m.pool, oracle: m.oracle, aToken: t.aToken, debtToken: await debtTokenOf(m, debtAsset),
      }, t.treasury);
      out.push({ ...read, control });
    } catch (e) {
      skipped++;
      console.log(`skipped ${l.transactionHash}: ${safeMessage(e).slice(0, 80)}`);
    }
    if (out.length % 20 === 0) writeFileSync(readsPath, JSON.stringify(out, null, 1) + "\n");
  }
  writeFileSync(readsPath, JSON.stringify(out, null, 1) + "\n");
  console.log(`read ${out.length} events, skipped ${skipped}`);

  const stamps = [...new Set(out.map((e) => e.timestamp))].sort((a, b) => a - b);
  const prices = [];
  for (let i = 0; i < stamps.length; i += 40) prices.push(...(await fetchLlama(stamps.slice(i, i + 40))));
  writeFileSync(join(dataDir, "control-wide-offchain.json"), JSON.stringify({
    fetchedAt: new Date().toISOString(),
    volatilityDay: busy,
    selection: { calmSize: CALM_SIZE, volatilitySize: VOLATILITY_SIZE, lookbackBlocks: LOOKBACK_BLOCKS, skipped },
    prices,
  }, null, 1) + "\n");
  console.log(`wrote ${prices.length} DefiLlama prices`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${safeMessage(e)}`);
    process.exit(1);
  });
}
