/**
 * Turns the replay output into Arkiv entity values. Pure, so it is tested without a network.
 * Addresses are lowercased, numeric attributes are numbers, and wei stays in the payload as a
 * string so no precision is lost.
 */
import type { LiquidationRow } from "../web/lib/lookup";

const MILLI_ETH = 10n ** 15n;
export const milliEth = (wei: string | bigint): bigint => BigInt(wei) / MILLI_ETH;

export interface MirrorRow {
  liquidationTx: string;
  logIndex: number;
  user: string;
  redress: string;
  vaultTx: string;
  fromBond: string;
  fromReserve: string;
  oracleAdapter: string;
  liquidator: string;
  builder: string;
}

export interface OraclePrice {
  txHash: string;
  logIndex: number;
  oracleCollateral: string;
  oracleDebt: string;
}

export const eventKey = (tx: string, logIndex: number) => `${tx.toLowerCase()}:${logIndex}`;

/** How far the oracle sat below the band's low, in basis points. Zero if it did not. */
export function deviationBps(row: Pick<LiquidationRow, "bandLow">, price: Pick<OraclePrice, "oracleCollateral" | "oracleDebt">): bigint {
  const low = BigInt(row.bandLow);
  if (low === 0n) return 0n;
  const oracle = (BigInt(price.oracleCollateral) * 10n ** 18n) / BigInt(price.oracleDebt);
  return oracle >= low ? 0n : ((low - oracle) * 10_000n) / low;
}

export function verdictValues(row: LiquidationRow, price: OraclePrice, mirror: MirrorRow | undefined, incidentId: string) {
  return {
    protocol: "aave-v3",
    chainId: 1n,
    block: BigInt(row.block),
    txHash: row.tx.toLowerCase(),
    logIndex: BigInt(row.logIndex),
    user: row.user.toLowerCase(),
    verdict: row.verdict,
    redressMilliEth: milliEth(row.redressFloor),
    deviationBps: deviationBps(row, price),
    srcCount: BigInt(row.sourcesUsed.length),
    incidentId,
    evidenceBzz: "",
    vaultTx: (row.vaultTx ?? "").toLowerCase(),
    payloadJson: JSON.stringify({ ...row, fromBond: mirror?.fromBond ?? "0", fromReserve: mirror?.fromReserve ?? "0" }),
  };
}

/** One true-up claim per address: the gap between the floor paid and the midpoint estimate. */
export function trueUpClaims(rows: readonly LiquidationRow[], incidentId: string) {
  const gaps = new Map<string, bigint>();
  for (const r of rows) {
    const user = r.user.toLowerCase();
    const gap = BigInt(r.redressMidpoint) - BigInt(r.redressFloor);
    gaps.set(user, (gaps.get(user) ?? 0n) + (gap > 0n ? gap : 0n));
  }
  return [...gaps].map(([user, gapWei]) => ({
    claimId: `trueup:${incidentId}:${user}`,
    user,
    kind: "trueup",
    status: "open",
    amountMilliEth: milliEth(gapWei),
    payloadJson: JSON.stringify({ user, incidentId, gapWei: gapWei.toString(), note: "Midpoint minus floor. Nothing pays this today: the vault pays the floor only." }),
  }));
}

export function recoveryValues(row: MirrorRow, ledger: string) {
  return {
    liquidationTx: row.liquidationTx.toLowerCase(),
    liquidator: row.liquidator.toLowerCase(),
    builder: row.builder.toLowerCase(),
    status: "open",
    amountMilliEth: milliEth(row.redress),
    payloadJson: JSON.stringify({ ...row, ledger }),
  };
}

export function incidentValues(id: string, startBlock: number, endBlock: number, rows: readonly LiquidationRow[], summary: unknown) {
  const total = rows.reduce((a, r) => a + BigInt(r.redressFloor), 0n);
  return {
    incidentId: id,
    protocol: "aave-v3",
    startBlock: BigInt(startBlock),
    endBlock: BigInt(endBlock),
    victims: BigInt(new Set(rows.map((r) => r.user.toLowerCase())).size),
    totalRedressMilliEth: milliEth(total),
    status: "paid-on-testnet",
    payloadJson: JSON.stringify(summary),
  };
}
