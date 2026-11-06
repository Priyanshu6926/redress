/**
 * Runs every incident liquidation through the real CRE workflow with --broadcast, checks each
 * payout on the write chain, and records it in replay/out/mirror-<target>.json.
 *
 *   bun replay/mirror.ts fork             all events, on the local fork
 *   bun replay/mirror.ts sepolia          all events, on Sepolia
 *   bun replay/mirror.ts fork --limit 1   stop after one event
 *
 * Resumes from the output file, so a failed run never pays a position twice. The first run
 * of a target saves its redacted transcript to docs/transcripts/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Hash, type PublicClient } from "viem";
import type { Row } from "./evaluate";
import type { Results } from "./replay";

const root = join(import.meta.dir, "..");
const outDir = join(import.meta.dir, "out");
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public development key
const LOCAL_RPC = "http://127.0.0.1:8545";

const vaultAbi = parseAbi([
  "event Paid(bytes32 indexed liquidationTx, address indexed user, address asset, uint256 amount, uint8 source)",
  "event Queued(bytes32 indexed liquidationTx, uint32 logIndex, address indexed user, uint256 amount)",
]);

export interface MirrorRow {
  liquidationTx: string;
  logIndex: number;
  user: string;
  verdict: string;
  redress: string;
  vaultTx: string;
  paid: boolean;
  queued: boolean;
  fromBond: string;
  fromReserve: string;
  oracleAdapter: string;
  liquidator: string;
  builder: string;
}

export interface Mirror {
  target: string;
  config: string;
  chainId: number;
  vault: string;
  payoutAsset: string;
  complete: boolean;
  totalPaidWei: string;
  rows: MirrorRow[];
}

/** Removes every configured secret from text before it is stored or shown. Pure. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

/** The workflow's structured result line, from simulator output. Pure. */
export function parseResult(output: string): { verdict: string; redress: string; logIndex: number; user: string; vaultTx: string; oracleAdapter: string; liquidator: string; builder: string } {
  const match = output.match(/REDRESS_RESULT (\{.*\})/);
  if (!match) throw new Error("no REDRESS_RESULT line in simulator output");
  // The simulator may print the line with escaped quotes when echoing the workflow result.
  return JSON.parse(match[1]!.replace(/\\"/g, '"'));
}

/** --evm-event-index is the position of a log within its transaction, not its block log index. Pure. */
export function eventIndexInTx(logs: readonly { logIndex: number }[], logIndex: number): number {
  const position = [...logs].sort((a, b) => a.logIndex - b.logIndex).findIndex((l) => l.logIndex === logIndex);
  if (position < 0) throw new Error(`log ${logIndex} not in receipt`);
  return position;
}

/** What a vault transaction paid, by source: 0 is the bond, 1 is the reserve. Pure. */
export function paidBySource(events: readonly { eventName: string; args: unknown }[]): { fromBond: bigint; fromReserve: bigint } {
  let fromBond = 0n;
  let fromReserve = 0n;
  for (const e of events) {
    if (e.eventName !== "Paid") continue;
    const { amount, source } = e.args as { amount: bigint; source: number };
    if (source === 0) fromBond += amount;
    else fromReserve += amount;
  }
  return { fromBond, fromReserve };
}

/** Stops the run if the workflow's result differs from the audited offline replay. Pure. */
export function assertMatches(row: Row, result: { verdict: string; redress: string }): void {
  if (row.verdict !== result.verdict || row.redress !== result.redress) {
    throw new Error(`${row.txHash}:${row.logIndex} replay ${row.verdict} ${row.redress}, workflow ${result.verdict} ${result.redress}`);
  }
}

function client(url: string): PublicClient {
  return createPublicClient({ transport: http(url, { retryCount: 5, retryDelay: 1000 }) }) as PublicClient;
}

async function requireChain(c: PublicClient, want: number, name: string) {
  const got = await c.getChainId();
  if (got !== want) throw new Error(`${name} answers chain id ${got}, expected ${want}. Check .env.`);
}

export function run(args: string[], env: Record<string, string>, secrets: (string | undefined)[]) {
  const exe = join(homedir(), ".cre", "bin", process.platform === "win32" ? "cre.exe" : "cre");
  const p = Bun.spawnSync([existsSync(exe) ? exe : "cre", ...args], { cwd: join(root, "cre"), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, text: redact(`${p.stdout.toString()}\n${p.stderr.toString()}`, secrets) };
}

async function main() {
  const target = process.argv[2];
  if (target !== "fork" && target !== "sepolia") throw new Error("usage: bun replay/mirror.ts <fork|sepolia> [--limit n]");
  const limitAt = process.argv.indexOf("--limit");
  const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;

  const secrets = [process.env.MAINNET_RPC, process.env.SEPOLIA_RPC, process.env.ETHERSCAN_API_KEY, process.env.CRE_ETH_PRIVATE_KEY];
  const fork = target === "fork";
  const readRpc = fork ? LOCAL_RPC : process.env.MAINNET_RPC;
  const writeRpc = fork ? LOCAL_RPC : process.env.SEPOLIA_RPC;
  const key = fork ? ANVIL_KEY : process.env.CRE_ETH_PRIVATE_KEY;
  if (!readRpc || !writeRpc || !key) throw new Error("set MAINNET_RPC, SEPOLIA_RPC and CRE_ETH_PRIVATE_KEY in .env");

  const reader = client(readRpc);
  const writer = client(writeRpc);
  await requireChain(reader, 1, "the read RPC");
  await requireChain(writer, fork ? 1 : 11155111, "the write RPC");

  const whoami = run(["whoami"], {}, secrets);
  if (!whoami.ok) throw new Error("not logged in to CRE. Run: cre login");

  const snapshot = await fetch("http://127.0.0.1:8787/offchain-prices.json").catch(() => undefined);
  if (!snapshot?.ok) throw new Error("snapshot server is not running. Run: bun replay/serve-snapshot.ts");

  const deployment = JSON.parse(readFileSync(join(root, "deployments", `${target}.json`), "utf8")) as { vault: Address; payoutAsset: Address };
  const results = JSON.parse(readFileSync(join(outDir, "results-default.json"), "utf8")) as Results;
  const path = join(outDir, `mirror-${target}.json`);
  const mirror: Mirror = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { target, config: "default", chainId: await writer.getChainId(), vault: deployment.vault, payoutAsset: deployment.payoutAsset, complete: false, totalPaidWei: "0", rows: [] };
  if (mirror.vault.toLowerCase() !== deployment.vault.toLowerCase()) throw new Error(`${path} belongs to another vault`);

  const done = new Set(mirror.rows.map((r) => `${r.liquidationTx}:${r.logIndex}`));
  const todo = results.incident.filter((r) => !done.has(`${r.txHash}:${r.logIndex}`)).slice(0, limit);

  for (const row of todo) {
    const receipt = await reader.getTransactionReceipt({ hash: row.txHash as Hash });
    const index = eventIndexInTx(receipt.logs, row.logIndex);
    const sim = run(
      ["workflow", "simulate", "sentinel-verdict", "--target", target, "--broadcast", "--non-interactive",
        "--trigger-index", "0", "--evm-tx-hash", row.txHash, "--evm-event-index", String(index)],
      { CRE_ETH_PRIVATE_KEY: key },
      secrets,
    );
    if (mirror.rows.length === 0) {
      mkdirSync(join(root, "docs", "transcripts"), { recursive: true });
      writeFileSync(join(root, "docs", "transcripts", `${target}.txt`), sim.text);
    }
    if (!sim.ok) throw new Error(`simulation failed for ${row.txHash}:\n${sim.text.slice(-1500)}`);

    const result = parseResult(sim.text);
    assertMatches(row, result);

    const vaultReceipt = await writer.getTransactionReceipt({ hash: result.vaultTx as Hash });
    const events = parseEventLogs({ abi: vaultAbi, logs: vaultReceipt.logs });
    const { fromBond, fromReserve } = paidBySource(events);
    const paid = fromBond + fromReserve > 0n;
    const queued = events.some((e) => e.eventName === "Queued");
    if (BigInt(row.redress) > 0n && !queued && fromBond + fromReserve !== BigInt(row.redress)) {
      throw new Error(`vault tx ${result.vaultTx} does not show the expected payment`);
    }

    mirror.rows.push({
      liquidationTx: row.txHash, logIndex: row.logIndex, user: row.user, verdict: row.verdict, redress: row.redress, vaultTx: result.vaultTx, paid, queued,
      fromBond: fromBond.toString(), fromReserve: fromReserve.toString(),
      oracleAdapter: result.oracleAdapter, liquidator: result.liquidator, builder: result.builder,
    });
    mirror.totalPaidWei = mirror.rows.filter((r) => r.paid).reduce((a, r) => a + BigInt(r.redress), 0n).toString();
    mirror.complete = mirror.rows.length === results.incident.length;
    writeFileSync(path, JSON.stringify(mirror, null, 1) + "\n");
    console.log(`${mirror.rows.length}/${results.incident.length} ${row.verdict} ${row.redress} vault tx ${result.vaultTx}`);
  }
  console.log(`done: ${mirror.rows.length} of ${results.incident.length} events, paid ${mirror.totalPaidWei} wei`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${redact((e as Error).message, [process.env.MAINNET_RPC, process.env.SEPOLIA_RPC, process.env.ETHERSCAN_API_KEY, process.env.CRE_ETH_PRIVATE_KEY])}`);
    process.exit(1);
  });
}
