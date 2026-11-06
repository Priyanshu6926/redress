/** Checks the frontend data contract: both data files validate, and the lookup behaves. */
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { jsonSource, lookup, type LiquidationRow } from "../web/lib/lookup";
import schema from "../docs/replay.schema.json";
import mock from "./out/replay.mock.json";
import real from "./out/replay.json";

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const errors = (data: unknown) => (validate(data) ? [] : validate.errors);

describe("schema", () => {
  test("replay.json validates", () => expect(errors(real)).toEqual([]));
  test("replay.mock.json validates", () => expect(errors(mock)).toEqual([]));

  test("rejects a row with a missing field", () => {
    const { vaultTx: _, ...row } = real.liquidations[0]!;
    expect(errors({ ...real, liquidations: [row] })).not.toEqual([]);
  });

  test("rejects a numeric amount, which would lose precision", () => {
    expect(errors({ ...real, liquidations: [{ ...real.liquidations[0], redressFloor: 1 }] })).not.toEqual([]);
  });
});

describe("real data", () => {
  test("no replay row uses the synthetic v4 hook", () => {
    expect(JSON.stringify(real).toLowerCase()).not.toContain("v4 hook");
  });

  test("is not marked as mock, and the mock is", () => {
    expect(real.mock).toBe(false);
    expect(mock.mock).toBe(true);
    expect(mock.incident.title).toContain("MOCK");
  });

  test("names the config and keeps floor and midpoint separate", () => {
    expect(real.config.name).toBe("default");
    expect(real.scorecard.paidFloor.eth).toBeLessThan(real.scorecard.comparisonMidpoint.eth);
  });

  test("rows sum to the scorecard", () => {
    const wei = real.liquidations.reduce((a, r) => a + BigInt(r.redressFloor), 0n);
    expect(Number(wei) / 1e18).toBeCloseTo(real.scorecard.paidFloor.eth, 5);
    expect(real.liquidations.length).toBe(real.scorecard.events);
  });

  test("the series ends at the total paid", () => {
    expect(real.series[real.series.length - 1]!.cumulativeRedressFloor).toBe(
      real.liquidations.reduce((a, r) => a + BigInt(r.redressFloor), 0n).toString(),
    );
  });

  test("never claims a vault transaction that does not exist", () => {
    const recorded = real.liquidations.filter((r) => r.vaultTx !== null).length;
    expect(recorded).toBe(real.scorecard.payouts.recorded);
  });
});

describe("lookup", () => {
  const source = jsonSource(real as { liquidations: LiquidationRow[] });
  const mockSource = jsonSource(mock as { liquidations: LiquidationRow[] });
  const both = "0x5e1b601245b942d99aa924d39e0fbec1786e2170";

  test("finds an address regardless of case and sums its rows", async () => {
    const lower = await lookup(source, both);
    const upper = await lookup(source, `0x${both.slice(2).toUpperCase()}`);
    expect(lower.status).toBe("wronged");
    expect(upper.rows.length).toBe(lower.rows.length);
    expect(new Set(lower.rows.map((r) => r.market)).size).toBe(2);
  });

  test("keeps rows in chain order", async () => {
    const { rows } = await lookup(source, both);
    expect(rows.map((r) => r.block)).toEqual([...rows.map((r) => r.block)].sort((a, b) => a - b));
  });

  test("gives a clean no-record for an unknown address", async () => {
    const r = await lookup(source, `0x${"ab".repeat(20)}`);
    expect(r.status).toBe("no-record");
    expect(r.totalRedressFloor).toBe("0");
  });

  test("rejects malformed input", async () => {
    expect((await lookup(source, "not an address")).status).toBe("invalid-address");
    expect((await lookup(source, "0x123")).status).toBe("invalid-address");
  });

  test("trims pasted whitespace", async () => {
    expect((await lookup(source, `  ${both}\n`)).status).toBe("wronged");
  });

  test("maps verdicts to page states", async () => {
    const at = (n: number) => `0x${String(n).repeat(40)}`;
    expect((await lookup(mockSource, at(1))).status).toBe("wronged");
    expect((await lookup(mockSource, at(3))).status).toBe("wronged");
    expect((await lookup(mockSource, at(5))).status).toBe("not-wronged");
    expect((await lookup(mockSource, at(6))).status).toBe("undetermined");
    expect((await lookup(mockSource, at(9))).status).toBe("not-wronged");
  });

  test("counts only rows with a vault transaction as paid", async () => {
    const r = await lookup(mockSource, `0x${"1".repeat(40)}`);
    expect(r.rows.length).toBe(2);
    expect(r.paidRows).toBe(1);
  });
});
