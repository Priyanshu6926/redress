import { describe, expect, test } from "bun:test";
import incident from "./data/incident-reads.json";
import offchain from "./data/offchain-prices.json";
import results from "./out/results-default.json";
import { boundary, falsePositives, overpricing, realControl, reserveExhaustion, singleSourceManipulation, sourceOutage } from "./controls";
import type { Row } from "./evaluate";
import type { EventReads } from "./reads";

const event = incident[0] as unknown as EventReads;
const rows = results.incident as unknown as Row[];
const safe = { verdict: "VALID", redress: "0" } as Row;

describe("negative controls", () => {
  test("a payout on any row is a false positive", () => {
    expect(falsePositives([safe, { verdict: "VALID", redress: "1" } as Row])).toHaveLength(1);
  });

  test("a verdict that allows payment is a false positive even at zero", () => {
    expect(falsePositives([{ verdict: "WRONGFUL", redress: "0" } as Row])).toHaveLength(1);
  });

  test("INCONCLUSIVE is safe, because it pays nothing", () => {
    expect(falsePositives([{ verdict: "INCONCLUSIVE", redress: "0" } as Row])).toHaveLength(0);
  });

  test("a real control fails below its minimum size", () => {
    expect(realControl(1, "calm", [safe], 200).pass).toBe(false);
  });

  test("a real control fails on one false positive", () => {
    const many = Array.from({ length: 200 }, () => safe);
    expect(realControl(1, "calm", [...many, { verdict: "WRONGFUL", redress: "5" } as Row], 200).pass).toBe(false);
  });

  test("an overpriced oracle pays nothing", () => {
    const c = overpricing(event, offchain.prices);
    expect(c.pass).toBe(true);
    expect(c.result).toContain("OVERPRICED");
  });

  test("a source outage pays nothing", () => {
    expect(sourceOutage(event).pass).toBe(true);
  });

  test("manipulating one source never raises a payout", () => {
    const c = singleSourceManipulation(event, offchain.prices);
    const after = /After \w+, (\d+) wei/.exec(c.result)!;
    expect(BigInt(after[1]!)).toBeLessThanOrEqual(BigInt(rows[0]!.redress));
  });

  test("the boundary event pays no more than its midpoint loss", () => {
    expect(boundary(rows).pass).toBe(true);
  });

  test("the reserve control queues what the cap cannot pay", () => {
    expect(reserveExhaustion(rows, 1_000n * 10n ** 18n, 2_000n).pass).toBe(true);
  });
});
