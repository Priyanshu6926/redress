import { describe, expect, test } from "bun:test";
import { decodeAbiParameters } from "viem";
import { effectiveBonusBps } from "./bonus";
import { MAX_LIQUIDATION_BONUS_BPS, REPORT_PARAMS, encodeReport, type Report } from "./report";

/** Bonus field sits at bits 32 to 47 of Aave's reserve configuration word. */
const config = (rawBonus: bigint) => (0xabcdn << 48n) | (rawBonus << 32n) | 0x1234n;

describe("effectiveBonusBps", () => {
  const base = { reserveConfig: config(10_600n), eModeCategory: 1n, eModeBonus: 10_100n, collateralBitmap: 1n << 5n, reserveId: 5n };

  test("uses the E-Mode bonus when the collateral is in the category", () => {
    expect(effectiveBonusBps(base)).toBe(100n);
  });

  test("uses the reserve bonus outside E-Mode", () => {
    expect(effectiveBonusBps({ ...base, eModeCategory: 0n })).toBe(600n);
  });

  test("uses the reserve bonus when the category does not list this collateral", () => {
    expect(effectiveBonusBps({ ...base, collateralBitmap: 1n << 6n })).toBe(600n);
  });

  test("rejects a raw value below 10,000", () => {
    expect(() => effectiveBonusBps({ ...base, eModeBonus: 100n })).toThrow(RangeError);
  });
});

describe("encodeReport", () => {
  const report: Report = {
    liquidationTx: `0x${"11".repeat(32)}`, logIndex: 7, blockNumber: 24626860n,
    user: "0x00000000000000000000000000000000000000B1",
    collateralAsset: "0x00000000000000000000000000000000000000C1", debtAsset: "0x00000000000000000000000000000000000000D1",
    debtToCover: 5n, collateralSeized: 6n, bandLowE18: 7n, bandHighE18: 8n, debtPriceHighE18: 9n, liquidationBonusBps: 600n,
    verdict: 1, sourceCount: 3, redress: 10n, evidenceHash: `0x${"22".repeat(32)}`,
    oracleAdapter: "0x0000000000000000000000000000000000000012", liquidator: "0x0000000000000000000000000000000000000013", builder: "0x0000000000000000000000000000000000000014",
  };

  test("round-trips through the ABI", () => {
    const [decoded] = decodeAbiParameters(REPORT_PARAMS, encodeReport(report));
    expect(decoded).toEqual(report);
  });

  test("fits the CRE report limit recorded in the PRD", () => {
    expect((encodeReport(report).length - 2) / 2).toBeLessThan(1024);
  });

  test("refuses a bonus the vault would reject", () => {
    expect(() => encodeReport({ ...report, liquidationBonusBps: MAX_LIQUIDATION_BONUS_BPS + 1n })).toThrow(RangeError);
    expect(() => encodeReport({ ...report, liquidationBonusBps: MAX_LIQUIDATION_BONUS_BPS })).not.toThrow();
  });
});
