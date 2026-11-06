import { describe, expect, test } from "bun:test";
import { findProtocolFee, fmt18, safeMessage, scanRange, summarize } from "./onchain";

const E18 = 10n ** 18n;

describe("summarize", () => {
  test("counts distinct users case-insensitively and sums amounts", () => {
    const s = summarize([
      { user: "0xAbC0000000000000000000000000000000000001", collateralSeized: (10n * E18).toString(), debtToCover: (11n * E18).toString(), stEthPerToken: ((12n * E18) / 10n).toString() },
      { user: "0xabc0000000000000000000000000000000000001", collateralSeized: (5n * E18).toString(), debtToCover: (6n * E18).toString(), stEthPerToken: E18.toString() },
    ]);
    expect(s).toEqual({ count: 2, users: 1, collateralSeized: 15n * E18, debtCovered: 17n * E18, netLossAtLidoRate: 0n });
  });
});

describe("findProtocolFee", () => {
  const LIQ = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
  const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const aToken = "0x00000000000000000000000000000000000000aa";
  const user = "0x00000000000000000000000000000000000000b1";
  const treasury = "0x00000000000000000000000000000000000000c1";
  const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const fee = (logIndex: number, amount: bigint, address = aToken, from = user, to = treasury) => ({
    address, logIndex, topics: [XFER, pad(from), pad(to)], data: "0x" + amount.toString(16).padStart(64, "0"),
  });
  const liq = (logIndex: number) => ({ address: "0x00000000000000000000000000000000000000dd", logIndex, topics: [LIQ], data: "0x" });

  test("attributes each fee to its own liquidation in a multi-liquidation tx", () => {
    const logs = [fee(1, 5n), liq(2), fee(3, 7n), liq(4)];
    expect(findProtocolFee(logs, 2, aToken, user, treasury)).toBe(5n);
    expect(findProtocolFee(logs, 4, aToken, user, treasury)).toBe(7n);
  });

  test("ignores other tokens, senders and recipients", () => {
    const other = "0x00000000000000000000000000000000000000ee";
    const logs = [fee(1, 5n, other), fee(2, 6n, aToken, other), fee(3, 8n, aToken, user, other), liq(4)];
    expect(findProtocolFee(logs, 4, aToken, user, treasury)).toBe(0n);
  });

  test("matches addresses regardless of case", () => {
    const logs = [fee(1, 5n), liq(2)];
    expect(findProtocolFee(logs, 2, aToken.toUpperCase().replace("0X", "0x"), user, treasury)).toBe(5n);
  });
});

describe("safeMessage", () => {
  test("removes the RPC URL and API key from error text", () => {
    const saved = [process.env.MAINNET_RPC, process.env.ETHERSCAN_API_KEY];
    process.env.MAINNET_RPC = "https://rpc.example/secret-key";
    process.env.ETHERSCAN_API_KEY = "etherscan-secret";
    const text = safeMessage(new Error("HTTP 429 from https://rpc.example/secret-key apikey=etherscan-secret"));
    [process.env.MAINNET_RPC, process.env.ETHERSCAN_API_KEY] = saved;
    expect(text).toBe("HTTP 429 from [redacted] apikey=[redacted]");
  });
});

describe("fmt18", () => {
  test("truncates and keeps sign", () => {
    expect(fmt18(1234567890000000000n, 3)).toBe("1.234");
    expect(fmt18(-5n * 10n ** 17n, 1)).toBe("-0.5");
    expect(fmt18(7n * E18, 0)).toBe("7");
  });
});

describe("scanRange", () => {
  test("covers every block exactly once when the RPC forces smaller chunks", async () => {
    const seen: bigint[] = [];
    await scanRange(0n, 99n, async (f, t) => {
      if (t - f + 1n > 16n) throw new Error("range too large");
      for (let b = f; b <= t; b++) seen.push(b);
      return [];
    }, 64n);
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => BigInt(i)));
  });

  test("throws instead of silently skipping a range", async () => {
    await expect(scanRange(0n, 9n, async () => { throw new Error("down"); }, 8n)).rejects.toThrow("log scan failed");
  });
});
