/**
 * Runs one incident event through the workflow with the synthetic v4 hook as an extra source.
 * Dry run: nothing is signed or written, and the result never enters replay.json. It proves the
 * hook band can feed a verdict, not that the hook played any part in the incident.
 *
 * Needs the snapshot server: bun replay/serve-snapshot.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Hash } from "viem";
import { eventIndexInTx, run } from "./mirror";
import type { Results } from "./replay";

const root = join(import.meta.dir, "..");
const secrets = [process.env.MAINNET_RPC, process.env.SEPOLIA_RPC, process.env.ETHERSCAN_API_KEY, process.env.CRE_ETH_PRIVATE_KEY];

if (!process.env.MAINNET_RPC || !process.env.SEPOLIA_RPC || !process.env.CRE_ETH_PRIVATE_KEY) throw new Error("set MAINNET_RPC, SEPOLIA_RPC and CRE_ETH_PRIVATE_KEY in .env");

const results = JSON.parse(readFileSync(join(import.meta.dir, "out", "results-default.json"), "utf8")) as Results;
const row = results.incident[0]!;
const reader = createPublicClient({ transport: http(process.env.MAINNET_RPC) });
const receipt = await reader.getTransactionReceipt({ hash: row.txHash as Hash });

const sim = run(
  ["workflow", "simulate", "sentinel-verdict", "--target", "demo-v4hook", "--non-interactive",
    "--trigger-index", "0", "--evm-tx-hash", row.txHash, "--evm-event-index", String(eventIndexInTx(receipt.logs, row.logIndex))],
  { CRE_ETH_PRIVATE_KEY: process.env.CRE_ETH_PRIVATE_KEY },
  secrets,
);

mkdirSync(join(root, "docs", "transcripts"), { recursive: true });
writeFileSync(join(root, "docs", "transcripts", "demo-v4hook.txt"), sim.text);
if (!sim.ok) throw new Error(`simulation failed:\n${sim.text.slice(-1200)}`);

const match = sim.text.match(/REDRESS_DEMO (\{.*\})/);
if (!match) throw new Error("no REDRESS_DEMO line in simulator output");
const result = JSON.parse(match[1]!.replace(/\\"/g, '"'));
const note = "Synthetic demo. The hook pool is ours and played no part in the incident. Nothing was written.";
writeFileSync(join(import.meta.dir, "out", "demo-v4hook.json"), JSON.stringify({ note, ...result }, null, 1) + "\n");
console.log(result);
