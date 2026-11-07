/**
 * Arkiv is the queryable index of verdicts. The chain stays the source of truth: the vault's
 * events are canonical, and an entity only points at them. See arkiv/schema.md.
 */
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq, gte, lte } from "@arkiv-network/sdk/query";
import { bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { hexToString, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ExplorerFilter, LiquidationRow, VerdictSource } from "../web/lib/lookup";

export type { ExplorerFilter };

export const Verdicts = defineSchema("redress.verdict", {
  protocol: str().indexed(),
  chainId: u64().indexed(),
  block: u64().indexed(),
  txHash: str().indexed(),
  logIndex: u64().indexed(),
  user: str().indexed(),
  verdict: str().indexed(),
  redressMilliEth: u64().indexed(),
  deviationBps: u64().indexed(),
  srcCount: u64().indexed(),
  incidentId: str().indexed(),
  evidenceBzz: str(),
  vaultTx: str().indexed(),
  payload: bytes(),
});

export const Incidents = defineSchema("redress.incident", {
  incidentId: str().indexed(),
  protocol: str().indexed(),
  startBlock: u64().indexed(),
  endBlock: u64().indexed(),
  victims: u64().indexed(),
  totalRedressMilliEth: u64().indexed(),
  status: str().indexed(),
  payload: bytes(),
});

export const Claims = defineSchema("redress.claim", {
  claimId: str().indexed(),
  user: str().indexed(),
  kind: str().indexed(),
  status: str().indexed(),
  amountMilliEth: u64().indexed(),
  payload: bytes(),
});

export const Recoveries = defineSchema("redress.recovery", {
  liquidationTx: str().indexed(),
  liquidator: str().indexed(),
  builder: str().indexed(),
  status: str().indexed(),
  amountMilliEth: u64().indexed(),
  payload: bytes(),
});

const chain = () => rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });

// The public endpoint answers 429 when its anonymous budget runs out. Retrying hides that as a
// hang, so reads fail fast and the caller falls back.
export const arkivReader = () => createPublicClient({ chain: chain(), transport: http(undefined, { retryCount: 0, timeout: 8_000 }) });

export function arkivWriter(privateKey: string) {
  const key = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  return createWalletClient({ chain: chain(), transport: http(), account: privateKeyToAccount(key) });
}

type Reader = ReturnType<typeof arkivReader>;

const rowOf = (entity: { payload: { value: Hex } }): LiquidationRow => JSON.parse(hexToString(entity.payload.value)) as LiquidationRow;

/** Verdicts for an address, read from Arkiv. */
export function arkivSource(client: Reader, owner?: string): VerdictSource {
  return {
    rowsForAddress: async (address) => {
      let query = client.select({ payload: true }).from(Verdicts).where(eq("user", address.toLowerCase())).limit(100);
      if (owner) query = query.ownedBy(owner as Hex);
      const page = await query.fetch();
      return page.entities.map(rowOf);
    },
  };
}

/** The incident explorer's query. Indexed attributes are filtered by the node, not in JavaScript. */
export async function explore(client: Reader, f: ExplorerFilter, owner?: string): Promise<LiquidationRow[]> {
  const clauses: unknown[] = [eq("incidentId", f.incidentId ?? "aave-2026-03-10")];
  if (f.verdict) clauses.push(eq("verdict", f.verdict));
  if (f.minMilliEth !== undefined) clauses.push(gte("redressMilliEth", u64(BigInt(f.minMilliEth))));
  if (f.maxMilliEth !== undefined) clauses.push(lte("redressMilliEth", u64(BigInt(f.maxMilliEth))));
  if (f.fromBlock !== undefined) clauses.push(gte("block", u64(BigInt(f.fromBlock))));
  if (f.toBlock !== undefined) clauses.push(lte("block", u64(BigInt(f.toBlock))));

  let query = client.select({ payload: true }).from(Verdicts).where(and(...(clauses as [never])) as never).orderBy(desc("redressMilliEth")).limit(100);
  if (owner) query = query.ownedBy(owner as Hex);
  const page = await query.fetch();
  return page.entities.map(rowOf);
}

export type Served<T> = { source: "arkiv" | "json-fallback"; data: T };

/** Reads Arkiv, and falls back to the JSON helper if Arkiv fails. The caller is told which served. */
export async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<Served<T>> {
  try {
    return { source: "arkiv", data: await primary() };
  } catch {
    return { source: "json-fallback", data: await fallback() };
  }
}
