import { describe, expect, test } from "bun:test";
import { llamaEntry, medianGapBps } from "./fetch-offchain";

describe("llamaEntry", () => {
  const wst = [{ timestamp: 900, price: 3000 }, { timestamp: 1100, price: 2460 }];
  const weth = [{ timestamp: 1020, price: 2000 }];

  test("divides the nearest legs and keeps them on record", () => {
    const e = llamaEntry(1050, wst, weth)!;
    expect(e.price).toBe("1230000000000000000");
    expect(e.legs).toEqual({ wstEthUsd: 2460, wstEthTimestamp: 1100, wethUsd: 2000, wethTimestamp: 1020 });
  });

  test("dates the entry by the leg further from the target", () => {
    expect(llamaEntry(1050, wst, weth)!.timestamp).toBe(1100);
    expect(llamaEntry(1030, [{ timestamp: 1031, price: 1 }], [{ timestamp: 900, price: 1 }])!.timestamp).toBe(900);
  });

  test("returns nothing when a leg is missing", () => {
    expect(llamaEntry(1000, [], weth)).toBeUndefined();
  });
});

test("medianGapBps measures distance from the reference rate", () => {
  const entry = (price: string) => ({ name: "x", timestamp: 1, price });
  expect(medianGapBps([entry("1000000000000000000"), entry("1010000000000000000"), entry("1100000000000000000")], () => 1)).toBeCloseTo(100, 6);
});
