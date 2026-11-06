/**
 * Live mode. Scans recent wstETH liquidations on Aave Core and Prime, runs the same reads and
 * engine as the replay, and writes replay/out/live.json for the Live Monitor. It pays nothing.
 *
 *   bun backend/watcher.ts           one scan
 *   bun backend/watcher.ts --watch   rescans every five minutes
 *
 * Normal days should read VALID. Only wstETH collateral is covered, because the sources are
 * wstETH-specific, and the output says how much of the market that leaves out.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseAbi, type Address, type Hash } from "viem";
import { DEFAULT_CONFIG } from "../cre/sentinel-verdict/verdict";
import { evaluate, type Row } from "../replay/evaluate";
import { fetchLlama } from "../replay/fetch-offchain";
import { etherscanLogs, type RawLog } from "../replay/fetch-reads";
import { EXECUTION_TX, WSTETH, aTokenAbi, makeClient, reserveAbi, resolveMarkets, safeMessage } from "../replay/onchain";
import { readEvent, type EventReads } from "../replay/reads";

const LOOKBACK_BLOCKS = 216_000; // about 30 days
const MAX_EVENTS = 25;
const RESCAN_MS = 5 * 60_000;
const debtTokenAbi = parseAbi(["function getReserveVariableDebtToken(address asset) view returns (address)"]);
const outPath = join(import.meta.dir, "..", "replay", "out", "live.json");

export interface LiveEvent {
  block: number;
  market: string;
  pair: string;
  gate: "open" | "closed";
  verdict: string;
  tx: string;
  redressWouldBe: string;
}

/** The Live Monitor's row. Pure. */
export function liveEvent(r: Row): LiveEvent {
  return {
    block: r.block,
    market: r.market.includes("Lido") ? "Prime" : "Core",
    pair: `wstETH / ${r.debtAsset.slice(0, 8)}…`,
    gate: r.gateOpen ? "open" : "closed",
    verdict: r.verdict,
    tx: r.txHash,
    redressWouldBe: r.redress,
  };
}

async function scan() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  const c = makeClient();
  const toBlock = Number(await c.getBlockNumber());
  const fromBlock = toBlock - LOOKBACK_BLOCKS;

  const B = (await c.getTransactionReceipt({ hash: EXECUTION_TX })).blockNumber;
  const markets = (await resolveMarkets(c, B)).filter((m) => /Aave Ethereum Market|Lido/.test(m.name));

  const logs: RawLog[] = [];
  for (const m of markets) logs.push(...(await etherscanLogs(m.pool, fromBlock, toBlock, key)));
  const recent = logs
    .filter((l) => !l.topics[2]!.endsWith(WSTETH.slice(2).toLowerCase()))
    .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber))
    .slice(0, MAX_EVENTS);

  const reads: EventReads[] = [];
  let skipped = 0;
  for (const l of recent) {
    const m = markets.find((x) => x.pool.toLowerCase() === l.address.toLowerCase())!;
    try {
      const debtAsset = getAddress("0x" + l.topics[2]!.slice(26));
      const aToken = await c.readContract({ address: m.pool, abi: reserveAbi, functionName: "getReserveAToken", args: [WSTETH], blockNumber: B });
      const treasury = await c.readContract({ address: aToken, abi: aTokenAbi, functionName: "RESERVE_TREASURY_ADDRESS", blockNumber: B });
      const debtToken: Address = await c.readContract({ address: m.pool, abi: debtTokenAbi, functionName: "getReserveVariableDebtToken", args: [debtAsset], blockNumber: B });
      const words = l.data.slice(2).match(/.{64}/g)!;
      reads.push(await readEvent(c, {
        txHash: l.transactionHash as Hash, blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex),
        user: getAddress("0x" + l.topics[3]!.slice(26)), debtAsset,
        debtToCover: BigInt("0x" + words[0]!).toString(), collateralEvent: BigInt("0x" + words[1]!).toString(),
        market: m.name, pool: m.pool, oracle: m.oracle, aToken, debtToken,
      }, treasury));
    } catch (e) {
      skipped++;
      console.log(`skipped ${l.transactionHash}: ${safeMessage(e).slice(0, 80)}`);
    }
  }

  const stamps = [...new Set(reads.map((r) => r.timestamp))];
  const offchain = stamps.length ? await fetchLlama(stamps) : [];
  const rows = evaluate(reads, DEFAULT_CONFIG, offchain);
  const events = rows.map(liveEvent).sort((a, b) => b.block - a.block);

  writeFileSync(outPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    fromBlock,
    toBlock,
    note: `wstETH collateral only. ${logs.length} found, ${events.length} evaluated, ${skipped} skipped.`,
    events,
  }, null, 1) + "\n");
  console.log(`scanned ${fromBlock} to ${toBlock}: ${events.length} events`);
}

if (import.meta.main) {
  const run = () => scan().catch((e) => console.error(`error: ${safeMessage(e)}`));
  await run();
  if (process.argv.includes("--watch")) setInterval(run, RESCAN_MS);
}
