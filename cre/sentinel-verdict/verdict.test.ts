import { describe, expect, test } from "bun:test";
import { computeRedress, type VerdictType } from "./verdict";
import file from "../../contracts/test/vectors/redress-vectors.json";

describe("computeRedress shared vectors", () => {
  test("count field matches the vector list", () => {
    expect(file.vectors.length).toBe(file.count);
  });

  for (const v of file.vectors) {
    test(v.name, () => {
      const got = computeRedress(
        v.verdict as VerdictType,
        BigInt(v.collateralSeized),
        BigInt(v.debtToCover),
        BigInt(v.bandLowE18),
        BigInt(v.debtPriceHighE18),
        BigInt(v.bonusBps),
      );
      expect(got).toBe(BigInt(v.redress));
    });
  }
});
