/**
 * Publishes the incident to the Arkiv testnet in batches. Resumes from replay/out/arkiv.json, so
 * an interrupted run never writes an entity twice.
 *
 *   bun replay/publish-arkiv.ts            everything
 *   bun replay/publish-arkiv.ts --limit 1  one batch
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExpirationTime } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/schema";
import { stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Claims, Incidents, Recoveries, Verdicts, arkivWriter } from "../backend/arkiv";
import { eventKey, incidentValues, recoveryValues, trueUpClaims, verdictValues, type MirrorRow, type OraclePrice } from "../backend/entities";
import type { LiquidationRow } from "../web/lib/lookup";

const BATCH = 10;
const LONG_LIVED_DAYS = Number(process.env.ARKIV_RECORD_DAYS ?? 180); // the protocol caps lifetime; see arkiv/friction.md
const CLAIM_DAYS = 7;
const RECOVERY_DAYS = 90;

const root = join(import.meta.dir, "..");
const out = join(import.meta.dir, "out");
const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

const key = process.env.CRE_ETH_PRIVATE_KEY;
if (!key) throw new Error("set CRE_ETH_PRIVATE_KEY in .env");
const writer = arkivWriter(key);
const owner = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;

const replay = read<{ incident: { id: string; firstLiquidationBlock: number; lastLiquidationBlock: number }; liquidations: LiquidationRow[]; scorecard: unknown }>(join(out, "replay.json"));
const mirror = read<{ complete: boolean; rows: MirrorRow[] }>(join(out, "mirror-sepolia.json"));
const reads = read<OraclePrice[]>(join(root, "replay", "data", "incident-reads.json"));
const ledger = read<{ recoveryLedger: string }>(join(root, "deployments", "sepolia.json")).recoveryLedger;
if (!mirror.complete) throw new Error("the Sepolia mirror is not complete");

const id = replay.incident.id;
const priceOf = new Map(reads.map((r) => [eventKey(r.txHash, r.logIndex), r]));
const mirrorOf = new Map(mirror.rows.map((r) => [eventKey(r.liquidationTx, r.logIndex), r]));

const split = <T extends { payloadJson: string }>(v: T) => {
  const { payloadJson, ...rest } = v;
  // A bare bigint is read as u256, so every numeric column is wrapped.
  const typed = Object.fromEntries(Object.entries(rest).map(([k, x]) => [k, typeof x === "bigint" ? u64(x) : x]));
  return { ...typed, payload: stringToBytes(payloadJson) };
};

type Create = { name: string; schema: unknown; values: unknown; expiration: unknown };
const creates: Create[] = [];
const add = (name: string, schema: unknown, values: { payloadJson: string }, days: number) =>
  creates.push({ name, schema, values: split(values), expiration: ExpirationTime.fromDays(days) });

add(`incident:${id}`, Incidents, incidentValues(id, replay.incident.firstLiquidationBlock, replay.incident.lastLiquidationBlock, replay.liquidations, replay.scorecard), LONG_LIVED_DAYS);
for (const row of replay.liquidations) {
  const k = eventKey(row.tx, row.logIndex);
  add(`verdict:${k}`, Verdicts, verdictValues(row, priceOf.get(k)!, mirrorOf.get(k), id), LONG_LIVED_DAYS);
}
for (const claim of trueUpClaims(replay.liquidations, id)) add(`claim:${claim.user}`, Claims, claim, CLAIM_DAYS);
for (const row of mirror.rows) add(`recovery:${eventKey(row.liquidationTx, row.logIndex)}`, Recoveries, recoveryValues(row, ledger), RECOVERY_DAYS);

const statePath = join(out, "arkiv.json");
const state = existsSync(statePath)
  ? read<{ writer: string; entities: Record<string, string>; txs: string[] }>(statePath)
  : { writer: owner, entities: {} as Record<string, string>, txs: [] as string[] };

const todo = creates.filter((c) => !state.entities[c.name]);
const limitAt = process.argv.indexOf("--limit");
const batches = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;

let done = 0;
for (let i = 0; i < todo.length && done < batches; i += BATCH, done++) {
  const chunk = todo.slice(i, i + BATCH);
  const result = await writer.executeBatch({ creates: chunk.map(({ schema, values, expiration }) => ({ schema, values, expiration })) as never });
  chunk.forEach((c, j) => (state.entities[c.name] = result.createdEntities[j]!));
  state.txs.push(result.txHash);
  writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
  console.log(`${Object.keys(state.entities).length}/${creates.length} entities, tx ${result.txHash}`);
}
console.log(`done: ${Object.keys(state.entities).length} of ${creates.length} entities, writer ${owner}`);
