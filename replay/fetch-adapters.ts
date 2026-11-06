/**
 * Reads AaveOracle.getSourceOfAsset(wstETH) at every incident block and checks each block's
 * coinbase against the incident file. Writes replay/data/incident-adapters.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { WSTETH } from "./onchain";
import type { EventReads } from "./reads";

const abi = parseAbi(["function getSourceOfAsset(address) view returns (address)", "function getCurrentBlockCoinbase() view returns (address)"]);
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const dataDir = join(import.meta.dir, "data");

const reads = JSON.parse(readFileSync(join(dataDir, "incident-reads.json"), "utf8")) as EventReads[];
const incident = JSON.parse(readFileSync(join(dataDir, "incident-2026-03-10.json"), "utf8")) as { liquidations: { txHash: string; logIndex: number; builder: string }[] };
const client = createPublicClient({ transport: http(process.env.MAINNET_RPC, { retryCount: 5, retryDelay: 1000 }) });

const events = [];
for (const r of reads) {
  const blockNumber = BigInt(r.blockNumber);
  const oracleAdapter = await client.readContract({ address: r.oracle as Address, abi, functionName: "getSourceOfAsset", args: [WSTETH as Address], blockNumber });
  const coinbase = await client.readContract({ address: MULTICALL3, abi, functionName: "getCurrentBlockCoinbase", blockNumber });
  const known = incident.liquidations.find((l) => l.txHash === r.txHash && l.logIndex === r.logIndex)!;
  if (coinbase.toLowerCase() !== known.builder.toLowerCase()) throw new Error(`coinbase differs at block ${r.blockNumber}`);
  events.push({ txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber, oracle: r.oracle, oracleAdapter, builder: coinbase });
}

writeFileSync(join(dataDir, "incident-adapters.json"), JSON.stringify({ source: "AaveOracle.getSourceOfAsset(wstETH) and block coinbase, read at each event's block", events }, null, 1) + "\n");
console.log(`${events.length} events, adapters: ${[...new Set(events.map((e) => e.oracleAdapter))].join(", ")}`);
