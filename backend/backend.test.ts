import { describe, expect, test } from "bun:test";
import type { Row } from "../replay/evaluate";
import { filterRows, type LiquidationRow } from "../web/lib/lookup";
import { withFallback } from "./arkiv";
import { liveEvent } from "./watcher";

const row = (verdict: string, floorEth: bigint, block: number) =>
  ({ verdict, block, redressFloor: (floorEth * 10n ** 18n).toString() }) as unknown as LiquidationRow;

const rows = [row("WRONGFUL", 5n, 100), row("WRONGFUL", 50n, 200), row("AMBIGUOUS", 1n, 300)];

describe("explorer fallback filter", () => {
  test("filters by verdict", () => {
    expect(filterRows(rows, { verdict: "AMBIGUOUS" })).toHaveLength(1);
  });

  test("filters by redress range in milli-ETH", () => {
    expect(filterRows(rows, { minMilliEth: 5_000, maxMilliEth: 10_000 }).map((r) => r.block)).toEqual([100]);
  });

  test("filters by block range", () => {
    expect(filterRows(rows, { fromBlock: 150, toBlock: 250 }).map((r) => r.block)).toEqual([200]);
  });

  test("sorts the largest redress first", () => {
    expect(filterRows(rows, {})[0]!.block).toBe(200);
  });
});

describe("Arkiv fallback", () => {
  test("says Arkiv answered when it does", async () => {
    expect(await withFallback(async () => 1, async () => 2)).toEqual({ source: "arkiv", data: 1 });
  });

  test("falls back and says so when Arkiv fails", async () => {
    const failing = async (): Promise<number> => {
      throw new Error("429");
    };
    expect(await withFallback(failing, async () => 2)).toEqual({ source: "json-fallback", data: 2 });
  });
});

describe("live monitor", () => {
  const base = { block: 5, market: "Aave V3 Lido Ethereum", debtAsset: "0xA0b86991c6218b36", verdict: "VALID", gateOpen: false, txHash: "0xaa", redress: "0" } as unknown as Row;

  test("a closed gate reads closed, in the same shape the page uses", () => {
    expect(liveEvent(base)).toEqual({ block: 5, market: "Prime", pair: "wstETH / 0xA0b869…", gate: "closed", verdict: "VALID", tx: "0xaa", redressWouldBe: "0" });
  });

  test("an open gate reads open", () => {
    expect(liveEvent({ ...base, gateOpen: true, market: "Aave Ethereum Market" }).gate).toBe("open");
  });
});
