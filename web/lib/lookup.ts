/**
 * "Was I wronged?" lookup. Plain TypeScript with no framework or chain dependency.
 * The page depends only on VerdictSource, so it reads replay.json today and can switch to
 * Arkiv later by adding one implementation of the same interface.
 */

export type Verdict = "VALID" | "WRONGFUL" | "EXCESS" | "AMBIGUOUS" | "INCONCLUSIVE" | "OVERPRICED";

/** One row of `liquidations` in docs/replay.schema.json. */
export interface LiquidationRow {
  market: string;
  user: string;
  tx: string;
  logIndex: number;
  block: number;
  debtToCover: string;
  collateralSeized: string;
  verdict: Verdict;
  hfWorst: string;
  bandLow: string;
  bandHigh: string;
  sourcesUsed: string[];
  sourcesRejected: string[];
  redressFloor: string;
  redressMidpoint: string;
  vaultTx: string | null;
  evidenceHash: string;
  multiAsset: boolean;
  bonusBps: string;
}

export interface VerdictSource {
  rowsForAddress(address: string): Promise<LiquidationRow[]>;
}

export type LookupStatus = "invalid-address" | "no-record" | "wronged" | "not-wronged" | "undetermined";

export interface LookupResult {
  status: LookupStatus;
  address: string;
  rows: LiquidationRow[];
  /** Sum of the floors, in wei. This is what is paid. */
  totalRedressFloor: string;
  /** Sum of midpoint losses, in wei. For comparison only. */
  totalRedressMidpoint: string;
  /** Rows that have a vault transaction. */
  paidRows: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PAYING: readonly Verdict[] = ["WRONGFUL", "EXCESS", "AMBIGUOUS"];

/** Reads rows from a parsed replay.json or replay.mock.json. */
export function jsonSource(data: { liquidations: LiquidationRow[] }): VerdictSource {
  const byUser = new Map<string, LiquidationRow[]>();
  for (const row of data.liquidations) {
    const key = row.user.toLowerCase();
    byUser.set(key, [...(byUser.get(key) ?? []), row]);
  }
  return { rowsForAddress: async (address) => byUser.get(address.toLowerCase()) ?? [] };
}

const sum = (rows: LiquidationRow[], field: "redressFloor" | "redressMidpoint") =>
  rows.reduce((total, row) => total + BigInt(row[field]), 0n).toString();

function statusOf(rows: LiquidationRow[]): LookupStatus {
  if (rows.length === 0) return "no-record";
  if (rows.some((r) => PAYING.includes(r.verdict) && BigInt(r.redressFloor) > 0n)) return "wronged";
  if (rows.every((r) => r.verdict === "INCONCLUSIVE")) return "undetermined";
  return "not-wronged";
}

export async function lookup(source: VerdictSource, input: string): Promise<LookupResult> {
  const address = input.trim();
  if (!ADDRESS.test(address)) {
    return { status: "invalid-address", address, rows: [], totalRedressFloor: "0", totalRedressMidpoint: "0", paidRows: 0 };
  }
  const rows = [...(await source.rowsForAddress(address))].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return {
    status: statusOf(rows),
    address,
    rows,
    totalRedressFloor: sum(rows, "redressFloor"),
    totalRedressMidpoint: sum(rows, "redressMidpoint"),
    paidRows: rows.filter((r) => r.vaultTx !== null).length,
  };
}

export interface ExplorerFilter {
  verdict?: string;
  minMilliEth?: number;
  maxMilliEth?: number;
  fromBlock?: number;
  toBlock?: number;
  incidentId?: string;
}

/** The same filter as Arkiv's, for when Arkiv is unavailable. Pure. */
export function filterRows(rows: readonly LiquidationRow[], f: ExplorerFilter): LiquidationRow[] {
  const milli = (r: LiquidationRow) => Number(BigInt(r.redressFloor) / 10n ** 15n);
  return rows
    .filter((r) => (f.verdict ? r.verdict === f.verdict : true))
    .filter((r) => (f.minMilliEth !== undefined ? milli(r) >= f.minMilliEth : true))
    .filter((r) => (f.maxMilliEth !== undefined ? milli(r) <= f.maxMilliEth : true))
    .filter((r) => (f.fromBlock !== undefined ? r.block >= f.fromBlock : true))
    .filter((r) => (f.toBlock !== undefined ? r.block <= f.toBlock : true))
    .sort((a, b) => (BigInt(b.redressFloor) > BigInt(a.redressFloor) ? 1 : -1));
}
