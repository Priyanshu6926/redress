/**
 * Compares replay results with the published figures. Writes replay/out/replay.json.
 * Nothing here feeds back into the engine: results are reported as they fall.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hfFloor } from "../cre/sentinel-verdict/verdict";
import { basePosition, isMultiAsset, type Row } from "./evaluate";
import { fmt18, type Liquidation } from "./onchain";
import type { EventReads } from "./reads";
import { outDir, runReplay, tally, type Results } from "./replay";

const WAD = 10n ** 18n;
const DAO_HEADLINE = 512.19;
const DAO_TABLE = 512.48;
const EXPECTED_POSITIONS = 34;
const dataDir = join(import.meta.dir, "data");

const sum = (rows: Row[], f: (r: Row) => string) => rows.reduce((a, r) => a + BigInt(f(r)), 0n);
const eth = (v: bigint) => Number(fmt18(v, 6));
const pctDiff = (got: number, want: number) => Number((((got - want) / want) * 100).toFixed(3));

export interface PositionSummary {
  market: string;
  user: string;
  events: number;
  verdicts: string[];
  redress: string;
}

/** Rolls events up to positions, keyed by market and user. Pure. */
export function positions(rows: Row[]): PositionSummary[] {
  const map = new Map<string, PositionSummary>();
  for (const r of rows) {
    const key = `${r.market}:${r.user}`.toLowerCase();
    const p = map.get(key) ?? { market: r.market, user: r.user, events: 0, verdicts: [], redress: "0" };
    p.events++;
    if (!p.verdicts.includes(r.verdict)) p.verdicts.push(r.verdict);
    p.redress = (BigInt(p.redress) + BigInt(r.redress)).toString();
    map.set(key, p);
  }
  return [...map.values()];
}

function summarise(r: Results) {
  const floor = eth(sum(r.incident, (x) => x.redress));
  const mid = eth(sum(r.incident, (x) => x.lossAtBandMid));
  const pos = positions(r.incident);
  const allWrongful = pos.filter((p) => p.verdicts.length === 1 && p.verdicts[0] === "WRONGFUL");
  const falsePositives = r.control.filter((x) => BigInt(x.redress) > 0n || (x.verdict !== "VALID" && x.verdict !== "INCONCLUSIVE"));
  return {
    config: r.config,
    banner: r.banner,
    offchainSnapshot: r.offchainSnapshot,
    incident: {
      events: r.incident.length,
      eventVerdicts: tally(r.incident),
      positions: pos.length,
      positionsAllWrongful: allWrongful.length,
      expectedPositions: EXPECTED_POSITIONS,
      positionsNotAllWrongful: pos.filter((p) => !allWrongful.includes(p)),
      redressFloorEth: floor,
      lossAtBandMidEth: mid,
      floorVsDaoHeadlinePct: pctDiff(floor, DAO_HEADLINE),
      floorVsDaoTablePct: pctDiff(floor, DAO_TABLE),
      midVsDaoHeadlinePct: pctDiff(mid, DAO_HEADLINE),
      midVsDaoTablePct: pctDiff(mid, DAO_TABLE),
    },
    control: {
      events: r.control.length,
      verdicts: tally(r.control),
      falsePositives: falsePositives.length,
      falsePositiveRows: falsePositives,
      totalRedressEth: eth(sum(r.control, (x) => x.redress)),
      wethDebtEvents: r.control.filter((x) => x.debtAsset.toLowerCase().startsWith("0xc02a")).length,
      eventsWithoutTwap: r.control.filter((x) => x.sourcesAvailable < 2).length,
    },
    rows: r.incident,
    controlRows: r.control,
  };
}

/** Rebuilt health factor at Aave's own prices against Aave's reported value (PRD section 11). */
function stateCheck(reads: EventReads[]) {
  const incident = JSON.parse(readFileSync(join(dataDir, "incident-2026-03-10.json"), "utf8")) as { liquidations: Liquidation[] };
  const reported = new Map(incident.liquidations.map((l) => [`${l.txHash}:${l.logIndex}`, BigInt(l.pre.healthFactor)]));

  const deviation = (r: EventReads) => {
    const p = basePosition(r);
    const price = (BigInt(r.preOracleCollateral) * WAD) / BigInt(r.preOracleWeth);
    const rebuilt = hfFloor(p.collateral, price, p.debt, WAD, p.ltBps);
    const aave = reported.get(`${r.txHash}:${r.logIndex}`)!;
    return Math.abs(Number(rebuilt - aave)) / Number(aave) * 10_000;
  };
  const single = reads.filter((r) => !isMultiAsset(r)).map(deviation);
  const multi = reads.filter(isMultiAsset).map(deviation);
  const bonusMismatch = (rows: Row[]) => rows.filter((r) => Math.abs(Number(r.impliedBonusBps) - Number(r.bonusBps)) > 5);
  return { singleAssetEvents: single.length, maxDeviationBpsSingle: Math.max(0, ...single), multiAssetEvents: multi.length, maxDeviationBpsMulti: Math.max(0, ...multi), bonusMismatch };
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

function printRows(rows: Row[]) {
  console.log("market  user            tx            verdict       hfWorst  redress     band                 sources  flags");
  for (const r of rows) {
    const hf = BigInt(r.hfWorst) > 10n ** 30n ? "max" : fmt18(BigInt(r.hfWorst), 4);
    console.log([
      (r.market.includes("Lido") ? "Prime" : "Core").padEnd(7),
      short(r.user).padEnd(15),
      r.txHash.slice(0, 12).padEnd(13),
      r.verdict.padEnd(13),
      hf.padEnd(8),
      fmt18(BigInt(r.redress), 4).padEnd(11),
      `${fmt18(BigInt(r.bandLow), 5)}-${fmt18(BigInt(r.bandHigh), 5)}`.padEnd(20),
      String(r.sourcesAvailable).padEnd(8),
      r.multiAsset ? "multi-asset" : "",
    ].join(" "));
  }
}

export function generateScorecard() {
  const results = runReplay();
  const reads = JSON.parse(readFileSync(join(dataDir, "incident-reads.json"), "utf8")) as EventReads[];
  const summaries = results.map(summarise);
  const check = stateCheck(reads);

  for (const s of summaries) {
    const i = s.incident;
    const c = s.control;
    console.log(`\n${s.banner}`);
    console.log(`Incident events: ${i.events}  ${JSON.stringify(i.eventVerdicts)}`);
    console.log(`Positions all WRONGFUL: ${i.positionsAllWrongful} of ${i.positions} (expected ${i.expectedPositions}/${i.expectedPositions})`);
    for (const p of i.positionsNotAllWrongful.slice(0, 6)) console.log(`  not all WRONGFUL: ${p.market} ${p.user} ${p.verdicts.join(",")} redress ${fmt18(BigInt(p.redress), 6)}`);
    console.log(`Redress floor:      ${i.redressFloorEth} ETH  (${i.floorVsDaoHeadlinePct}% vs 512.19, ${i.floorVsDaoTablePct}% vs 512.48)`);
    console.log(`Loss at band mid:   ${i.lossAtBandMidEth} ETH  (${i.midVsDaoHeadlinePct}% vs 512.19, ${i.midVsDaoTablePct}% vs 512.48)`);
    console.log(`Control: ${c.events} events (${c.wethDebtEvents} WETH debt)  ${JSON.stringify(c.verdicts)}  false positives ${c.falsePositives}  paid ${c.totalRedressEth} ETH  without TWAP ${c.eventsWithoutTwap}`);
  }

  const paying = results.find((r) => r.incident.some((x) => BigInt(x.redress) > 0n));
  if (paying) {
    console.log(`\n${paying.banner}\nPer-event rows:`);
    printRows(paying.incident);
  }

  console.log("\nState rebuild vs Aave getUserAccountData at block - 1:");
  console.log(`  single-asset events ${check.singleAssetEvents}: max deviation ${check.maxDeviationBpsSingle.toFixed(4)} bps`);
  console.log(`  multi-asset events ${check.multiAssetEvents}: max deviation ${check.maxDeviationBpsMulti.toFixed(4)} bps`);
  console.log(`  events where implied bonus differs from the bonus read: ${check.bonusMismatch(results[0]!.incident).length}`);

  const { bonusMismatch: _, ...stateRebuild } = check;
  writeFileSync(join(outDir, "replay.json"), JSON.stringify({ configs: summaries, stateRebuild }, null, 1) + "\n");
  console.log(`\nwrote ${join(outDir, "replay.json")}`);
}

if (import.meta.main) generateScorecard();
