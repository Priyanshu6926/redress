/**
 * Runs the seven negative controls of PRD 8.6 and writes replay/out/controls.json.
 * Results are reported as they fall. A control that does not meet its expectation stays a
 * failure here and is explained in the report: nothing is tuned to make it pass.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assess, type OffchainPrice } from "../cre/sentinel-verdict/position";
import { DEFAULT_CONFIG, VerdictType } from "../cre/sentinel-verdict/verdict";
import { evaluate, type Row } from "./evaluate";
import type { EventReads } from "./reads";

const dataDir = join(import.meta.dir, "data");
const load = <T>(file: string) => JSON.parse(readFileSync(join(dataDir, file), "utf8")) as T;
const verdictOf = (v: number) => VerdictType[v] as string;

export interface Control {
  id: number;
  name: string;
  expected: string;
  result: string;
  pass: boolean;
  kind: "real" | "synthetic";
}

const SAFE = new Set(["VALID", "INCONCLUSIVE"]);

/** A false positive is any payout, or any verdict that would allow one. Pure. */
export const falsePositives = (rows: readonly Row[]) => rows.filter((r) => BigInt(r.redress) > 0n || !SAFE.has(r.verdict));

function tally(rows: readonly Row[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
}

export function realControl(id: number, name: string, rows: readonly Row[], minEvents: number): Control {
  const wrong = falsePositives(rows);
  return {
    id, name, kind: "real",
    expected: `At least ${minEvents} real events, no payouts`,
    result: `${rows.length} events: ${tally(rows)}. False positives: ${wrong.length}`,
    pass: rows.length >= minEvents && wrong.length === 0,
  };
}

export function overpricing(event: EventReads, offchain: OffchainPrice[]): Control {
  const scaled = (BigInt(event.oracleCollateral) * 15n) / 10n;
  const r = assess({ ...event, oracleCollateral: scaled.toString(), preOracleCollateral: scaled.toString() }, [], DEFAULT_CONFIG, offchain);
  const verdict = verdictOf(r.outcome.verdict);
  return {
    id: 3, name: "Over-pricing glitch", kind: "synthetic",
    expected: "OVERPRICED, no payout",
    result: `${verdict}, redress ${r.redress} wei`,
    pass: verdict === "OVERPRICED" && r.redress === 0n,
  };
}

export function sourceOutage(event: EventReads): Control {
  const r = assess({ ...event, twapPrice: null }, [], DEFAULT_CONFIG, []);
  const verdict = verdictOf(r.outcome.verdict);
  return {
    id: 4, name: "Source outage", kind: "synthetic",
    expected: "INCONCLUSIVE, no payout",
    result: `${verdict}, redress ${r.redress} wei, with one source left`,
    pass: verdict === "INCONCLUSIVE" && r.redress === 0n,
  };
}

export function singleSourceManipulation(event: EventReads, offchain: OffchainPrice[]): Control {
  const base = assess(event, [], DEFAULT_CONFIG, offchain);
  const pushed = offchain.map((o) => (o.name === "defillama" ? { ...o, price: ((BigInt(o.price) * 105n) / 100n).toString() } : o));
  const r = assess(event, [], DEFAULT_CONFIG, pushed);
  const before = verdictOf(base.outcome.verdict);
  const after = verdictOf(r.outcome.verdict);
  return {
    id: 5, name: "Single-source manipulation (one source +5%)", kind: "synthetic",
    expected: "Outlier rejected, verdict unchanged",
    result: `Before ${before}, ${base.redress} wei. After ${after}, ${r.redress} wei`,
    pass: before === after && r.redress === base.redress,
  };
}

export function boundary(rows: readonly Row[]): Control {
  const ambiguous = rows.filter((r) => r.verdict === "AMBIGUOUS");
  const ok = ambiguous.length > 0 && ambiguous.every((r) => BigInt(r.redress) <= BigInt(r.lossAtBandMid));
  return {
    id: 6, name: "Boundary position", kind: "real",
    expected: "AMBIGUOUS, paying only the provable excess",
    result: `${ambiguous.length} real incident event(s) AMBIGUOUS. Paid ${ambiguous.map((r) => r.redress).join(", ")} wei against a midpoint loss of ${ambiguous.map((r) => r.lossAtBandMid).join(", ")} wei`,
    pass: ok,
  };
}

/** The vault's epoch rule, as in test_incidentAgainstASmallReserveQueuesAndNeverOverspends. Pure. */
export function reserveExhaustion(rows: readonly Row[], reserve: bigint, capBps: bigint): Control {
  const budget = (reserve * capBps) / 10_000n;
  let spent = 0n;
  let queued = 0;
  for (const r of rows) {
    const amount = BigInt(r.redress);
    if (amount === 0n) continue;
    if (spent + amount <= budget) spent += amount;
    else queued++;
  }
  return {
    id: 7, name: "Reserve exhaustion", kind: "synthetic",
    expected: "Payouts stop at the epoch cap, the rest queue",
    result: `${reserve / 10n ** 18n} ETH reserve, budget ${budget / 10n ** 18n} ETH: spent ${spent / 10n ** 18n} ETH, ${queued} queued. Also enforced on-chain by a Forge test`,
    pass: queued > 0 && spent <= budget,
  };
}

function main() {
  const incident = load<EventReads[]>("incident-reads.json");
  const offchainFile = load<{ prices: OffchainPrice[] }>("offchain-prices.json");
  const results = JSON.parse(readFileSync(join(import.meta.dir, "out", "results-default.json"), "utf8")) as { incident: Row[] };
  const event = incident[0]!;

  const controls: Control[] = [];
  const widePath = join(dataDir, "control-wide-reads.json");
  if (existsSync(widePath)) {
    const wide = JSON.parse(readFileSync(widePath, "utf8")) as (EventReads & { control: string })[];
    const prices = load<{ prices: OffchainPrice[]; volatilityDay: { day: string; count: number } }>("control-wide-offchain.json");
    controls.push(realControl(1, "Calm-day control", evaluate(wide.filter((r) => r.control === "calm"), DEFAULT_CONFIG, prices.prices), 200));
    controls.push(realControl(2, `Volatility control (${prices.volatilityDay.day})`, evaluate(wide.filter((r) => r.control === "volatility"), DEFAULT_CONFIG, prices.prices), 1));
  }
  controls.push(overpricing(event, offchainFile.prices));
  controls.push(sourceOutage(event));
  controls.push(singleSourceManipulation(event, offchainFile.prices));
  controls.push(boundary(results.incident));
  controls.push(reserveExhaustion(results.incident, 1_000n * 10n ** 18n, 2_000n));

  writeFileSync(join(import.meta.dir, "out", "controls.json"), JSON.stringify({ generatedAt: new Date().toISOString(), controls }, null, 1) + "\n");
  for (const c of controls) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}. ${c.name}: ${c.result}`);
}

if (import.meta.main) main();
