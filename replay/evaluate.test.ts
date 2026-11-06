import { describe, expect, test } from "bun:test";
import { CONFIGS, banner, basePosition, evaluate, sourcesFor, to18 } from "./evaluate";
import { countUserAssets, meanTick, priceAtTick, sqrtRatioAtTick, type EventReads } from "./reads";

const E18 = 10n ** 18n;
const [DEFAULT, TWO_SOURCES] = CONFIGS as [(typeof CONFIGS)[0], (typeof CONFIGS)[0]];

/** Synthetic healthy position hit by a low oracle. Oracle prices are in 8-decimal USD. */
function event(over: Partial<EventReads> = {}): EventReads {
  return {
    market: "m", pool: "0x00000000000000000000000000000000000000a1", oracle: "0x00000000000000000000000000000000000000a2",
    aToken: "0x00000000000000000000000000000000000000a3", debtToken: "0x00000000000000000000000000000000000000a4",
    txHash: "0x01", blockNumber: 100, logIndex: 1, user: "0x00000000000000000000000000000000000000b1",
    debtAsset: "0x00000000000000000000000000000000000000c1", debtToCover: (100n * E18).toString(), collateralEvent: (84n * E18).toString(),
    timestamp: 1000, debtDecimals: 18, protocolFee: E18.toString(), lidoRate: (12n * E18 / 10n).toString(), twapTick: 0,
    twapPrice: (12n * E18 / 10n).toString(), chainlinkStEthEth: E18.toString(),
    oracleCollateral: "11900000000", oracleDebt: "10000000000", oracleWeth: "10000000000",
    preOracleCollateral: "12000000000", preOracleWeth: "10000000000",
    preCollateralBalance: (300n * E18).toString(), preDebtBalance: (300n * E18).toString(),
    totalCollateralBase: "3600000000000", totalDebtBase: "3000000000000", ltBps: "9500", bonusBps: "100", eModeId: 1, borrows: 1, collaterals: 1,
    ...over,
  };
}

describe("tick math", () => {
  test("matches Uniswap's published constants", () => {
    expect(sqrtRatioAtTick(0)).toBe(79228162514264337593543950336n);
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n);
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n);
  });

  test("price at tick follows 1.0001^tick", () => {
    expect(priceAtTick(0)).toBe(E18);
    expect(Number(priceAtTick(2058)) / 1e18).toBeCloseTo(Math.pow(1.0001, 2058), 9);
    expect(Number(priceAtTick(-2058)) / 1e18).toBeCloseTo(Math.pow(1.0001, -2058), 9);
  });

  test("mean tick rounds towards negative infinity", () => {
    expect(meanTick(0n, 3601n, 1800)).toBe(2);
    expect(meanTick(0n, -3601n, 1800)).toBe(-3);
    expect(meanTick(0n, -3600n, 1800)).toBe(-2);
  });
});

test("countUserAssets reads the Aave bitmap", () => {
  expect(countUserAssets(0b1001n)).toEqual({ borrows: 1, collaterals: 1 });
  expect(countUserAssets(0b11011n)).toEqual({ borrows: 2, collaterals: 2 });
  expect(countUserAssets(0b101011n)).toEqual({ borrows: 1, collaterals: 3 });
});

test("to18 scales both ways", () => {
  expect(to18(5n, 6)).toBe(5n * 10n ** 12n);
  expect(to18(5n * 10n ** 20n, 20)).toBe(5n * E18);
});

describe("basePosition", () => {
  test("single asset uses token balances", () => {
    expect(basePosition(event())).toEqual({ collateral: 300n * E18, debt: 300n * E18, ltBps: 9500n, bonusBps: 100n });
  });

  test("multi asset values other collateral at the Lido rate, so a glitched wstETH price does not distort it", () => {
    // 100 wstETH at a glitched 1.0, plus 120 ETH of other collateral. Lido rate 1.2.
    const p = basePosition(event({
      collaterals: 2, preCollateralBalance: (100n * E18).toString(), preOracleCollateral: "10000000000",
      totalCollateralBase: "2200000000000", totalDebtBase: "500000000000",
    }));
    expect(p.collateral).toBe(200n * E18);
    expect(p.debt).toBe(50n * E18);
  });
});

describe("sourcesFor", () => {
  test("skips a missing TWAP and absent snapshots", () => {
    expect(sourcesFor(event({ twapPrice: null }), []).map((s) => s.name)).toEqual(["S1 Lido stEthPerToken"]);
  });

  test("takes the nearest snapshot per source", () => {
    const names = sourcesFor(event(), [
      { name: "api", timestamp: 500, price: "1" },
      { name: "api", timestamp: 990, price: "2" },
      { name: "other", timestamp: 1000, price: "3" },
    ]);
    expect(names.map((s) => s.price)).toEqual([12n * E18 / 10n, 12n * E18 / 10n, 2n, 3n]);
  });
});

describe("evaluate", () => {
  test("banner names the config", () => {
    expect(banner(TWO_SOURCES)).toContain("onchain-only-2src");
    expect(banner(TWO_SOURCES)).toContain("minSources=2");
  });

  test("two sources are INCONCLUSIVE at the default and classify under the named config", () => {
    const glitch = event({ oracleCollateral: "11000000000" });
    expect(evaluate([glitch], DEFAULT)[0]!.verdict).toBe("INCONCLUSIVE");
    expect(evaluate([glitch], TWO_SOURCES)[0]!.verdict).toBe("WRONGFUL");
  });

  test("subtracts earlier same-block liquidations of the same position only", () => {
    const first = event({ oracleCollateral: "11000000000", logIndex: 1 });
    const second = event({ oracleCollateral: "11000000000", logIndex: 5 });
    const otherMarket = event({ oracleCollateral: "11000000000", logIndex: 3, pool: "0x00000000000000000000000000000000000000ff" });
    const rows = evaluate([second, otherMarket, first], TWO_SOURCES);
    expect(rows.map((r) => r.logIndex)).toEqual([1, 3, 5]);
    expect(BigInt(rows[2]!.hfWorst)).not.toBe(BigInt(rows[0]!.hfWorst));
    expect(BigInt(rows[1]!.hfWorst)).toBe(BigInt(rows[0]!.hfWorst));
  });

  test("counts the protocol fee in C", () => {
    const glitch = event({ oracleCollateral: "11000000000", protocolFee: "0" });
    const withFee = event({ oracleCollateral: "11000000000", protocolFee: E18.toString() });
    expect(BigInt(evaluate([withFee], TWO_SOURCES)[0]!.redress)).toBeGreaterThan(BigInt(evaluate([glitch], TWO_SOURCES)[0]!.redress));
  });
});
