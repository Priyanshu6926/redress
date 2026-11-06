/**
 * Offline replay: runs the verdict engine over cached archive reads under every config.
 * Refresh the cache with `bun run replay:fetch`. Writes replay/out/results-<config>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig } from "../cre/sentinel-verdict/verdict";
import { CONFIGS, banner, evaluate, type OffchainPrice, type Row } from "./evaluate";
import type { EventReads } from "./reads";

const dataDir = join(import.meta.dir, "data");
export const outDir = join(import.meta.dir, "out");

export interface Results {
  config: Record<string, string | number>;
  banner: string;
  offchainSnapshot: boolean;
  incident: Row[];
  control: Row[];
}

function loadOffchain(): OffchainPrice[] {
  const path = join(dataDir, "offchain-prices.json");
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { prices: OffchainPrice[] }).prices;
}

const load = (file: string) => JSON.parse(readFileSync(join(dataDir, file), "utf8")) as EventReads[];

export function tally(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.verdict] = (out[r.verdict] ?? 0) + 1;
  return out;
}

function runConfig(cfg: EngineConfig, incident: EventReads[], control: EventReads[], offchain: OffchainPrice[]): Results {
  const results: Results = {
    config: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    banner: banner(cfg),
    offchainSnapshot: offchain.length > 0,
    incident: evaluate(incident, cfg, offchain),
    control: evaluate(control, cfg, offchain),
  };
  writeFileSync(join(outDir, `results-${cfg.name}.json`), JSON.stringify(results, null, 1) + "\n");
  return results;
}

export function runReplay(): Results[] {
  mkdirSync(outDir, { recursive: true });
  const offchain = loadOffchain();
  const incident = load("incident-reads.json");
  const control = load("control-reads.json");

  console.log(offchain.length ? `S3: using ${offchain.length} off-chain snapshot prices` : "S3: replay/data/offchain-prices.json absent, skipped");
  const all = CONFIGS.map((cfg) => {
    const r = runConfig(cfg, incident, control, offchain);
    console.log(`\n${r.banner}`);
    console.log("incident verdicts:", tally(r.incident));
    console.log("control verdicts: ", tally(r.control));
    return r;
  });

  const [a, b] = all as [Results, Results];
  const changed = a.incident.filter((row, i) => row.verdict !== b.incident[i]!.verdict).length;
  console.log(`\nDifference ${a.config.name} vs ${b.config.name}: ${changed} of ${a.incident.length} incident verdicts differ`);
  return all;
}

if (import.meta.main) runReplay();
