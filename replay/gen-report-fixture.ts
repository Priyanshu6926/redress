/**
 * Writes contracts/test/report-fixture.json: every incident row from a paying config,
 * encoded by report.ts, for the vault to accept at exactly the TypeScript redress.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { encodeReport } from "../cre/sentinel-verdict/report";
import { VerdictType } from "../cre/sentinel-verdict/verdict";
import { collateralGross, debtPriceEth, to18, type Row } from "./evaluate";
import { WSTETH } from "./onchain";
import type { EventReads } from "./reads";
import type { Results } from "./replay";

const CONFIG = process.argv[2] ?? "default";
const results = JSON.parse(readFileSync(join(import.meta.dir, "out", `results-${CONFIG}.json`), "utf8")) as Results;
const reads = JSON.parse(readFileSync(join(import.meta.dir, "data", "incident-reads.json"), "utf8")) as EventReads[];
const readOf = (row: Row) => reads.find((r) => r.txHash === row.txHash && r.logIndex === row.logIndex)!;

const reports = results.incident.map((row) => {
  const r = readOf(row);
  const report = encodeReport({
    liquidationTx: row.txHash as Hex,
    logIndex: row.logIndex,
    blockNumber: BigInt(row.block),
    user: row.user as Address,
    collateralAsset: WSTETH,
    debtAsset: row.debtAsset as Address,
    debtToCover: to18(BigInt(r.debtToCover), r.debtDecimals),
    collateralSeized: collateralGross(r),
    bandLowE18: BigInt(row.bandLow),
    bandHighE18: BigInt(row.bandHigh),
    debtPriceHighE18: debtPriceEth(r),
    liquidationBonusBps: BigInt(row.bonusBps),
    verdict: VerdictType[row.verdict as keyof typeof VerdictType],
    sourceCount: row.sourcesUsed.length,
    redress: BigInt(row.redress),
    evidenceHash: `0x${"00".repeat(32)}`,
  });
  return { report, redress: row.redress };
});

const totalRedress = reports.reduce((a, r) => a + BigInt(r.redress), 0n).toString();
const path = join(import.meta.dir, "..", "contracts", "test", "report-fixture.json");
writeFileSync(path, JSON.stringify({ config: CONFIG, count: String(reports.length), totalRedress, reports }, null, 1) + "\n");
console.log(`wrote ${reports.length} reports from ${CONFIG}, total redress ${totalRedress} wei`);
