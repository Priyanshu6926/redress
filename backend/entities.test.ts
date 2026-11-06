import { describe, expect, test } from "bun:test";
import type { LiquidationRow } from "../web/lib/lookup";
import { deviationBps, incidentValues, milliEth, recoveryValues, trueUpClaims, verdictValues, type MirrorRow } from "./entities";

const row = {
  market: "Aave Ethereum Market",
  user: "0xABCDEF0000000000000000000000000000000001",
  tx: "0xAA00000000000000000000000000000000000000000000000000000000000001",
  logIndex: 17,
  block: 100,
  verdict: "WRONGFUL",
  bandLow: "1200000000000000000",
  bandHigh: "1210000000000000000",
  sourcesUsed: ["S1", "S2", "S3"],
  redressFloor: "2500000000000000000",
  redressMidpoint: "3000000000000000000",
  vaultTx: "0xBB00000000000000000000000000000000000000000000000000000000000002",
} as unknown as LiquidationRow;

const price = { txHash: row.tx, logIndex: 17, oracleCollateral: "108000000000", oracleDebt: "100000000000" };

const mirror = {
  liquidationTx: row.tx, logIndex: 17, user: row.user, redress: row.redressFloor, vaultTx: row.vaultTx!,
  fromBond: "1000000000000000000", fromReserve: "1500000000000000000",
  oracleAdapter: "0xAD", liquidator: "0xLIQ", builder: "0xBLD",
} as MirrorRow;

describe("entity values", () => {
  test("milli-ETH rounds down", () => {
    expect(milliEth("1999999999999999")).toBe(1n);
    expect(milliEth(0n)).toBe(0n);
  });

  test("deviation is measured below the band low", () => {
    expect(deviationBps(row, price)).toBe(1000n);
  });

  test("an oracle at or above the band has no deviation", () => {
    expect(deviationBps(row, { oracleCollateral: "130", oracleDebt: "100" })).toBe(0n);
  });

  test("an empty band has no deviation", () => {
    expect(deviationBps({ bandLow: "0" }, price)).toBe(0n);
  });

  test("a verdict lowercases addresses and keeps numbers numeric", () => {
    const v = verdictValues(row, price, mirror, "incident");
    expect(v.user).toBe(row.user.toLowerCase());
    expect(v.txHash).toBe(row.tx.toLowerCase());
    expect(v.vaultTx).toBe(row.vaultTx!.toLowerCase());
    expect(v.redressMilliEth).toBe(2500n);
    expect(v.srcCount).toBe(3n);
    expect(typeof v.block).toBe("bigint");
  });

  test("a verdict payload keeps exact wei and both shares", () => {
    const body = JSON.parse(verdictValues(row, price, mirror, "incident").payloadJson);
    expect(body.redressFloor).toBe("2500000000000000000");
    expect(body.fromBond).toBe("1000000000000000000");
  });

  test("true-up claims group by address and ignore negative gaps", () => {
    const other = { ...row, redressFloor: "5000000000000000000", redressMidpoint: "4000000000000000000" };
    const claims = trueUpClaims([row, other], "incident");
    expect(claims).toHaveLength(1);
    expect(claims[0]!.amountMilliEth).toBe(500n);
    expect(claims[0]!.kind).toBe("trueup");
  });

  test("a recovery names the liquidator and builder in lowercase", () => {
    const r = recoveryValues(mirror, "0xledger");
    expect(r.liquidator).toBe("0xliq");
    expect(r.builder).toBe("0xbld");
    expect(r.amountMilliEth).toBe(2500n);
  });

  test("an incident counts addresses, not events", () => {
    const i = incidentValues("incident", 1, 2, [row, row], {});
    expect(i.victims).toBe(1n);
    expect(i.totalRedressMilliEth).toBe(5000n);
  });
});
