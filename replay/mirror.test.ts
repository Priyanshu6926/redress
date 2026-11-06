import { describe, expect, test } from "bun:test";
import type { Row } from "./evaluate";
import { assertMatches, eventIndexInTx, parseResult, redact } from "./mirror";

test("redact removes every secret and ignores unset ones", () => {
  expect(redact("rpc https://x/key and pk 0xabc", ["https://x/key", undefined, "0xabc"])).toBe("rpc [redacted] and pk [redacted]");
});

describe("parseResult", () => {
  const line = '{"verdict":"WRONGFUL","redress":"5","logIndex":3,"user":"0xa","vaultTx":"0xb"}';

  test("reads the structured line among other output", () => {
    expect(parseResult(`compiled\n[USER LOG] REDRESS_RESULT ${line}\nfinished`).redress).toBe("5");
  });

  test("handles a line printed with escaped quotes", () => {
    expect(parseResult(`REDRESS_RESULT ${line.replace(/"/g, '\\"')}`).vaultTx).toBe("0xb");
  });

  test("fails when the workflow produced no result", () => {
    expect(() => parseResult("skipped")).toThrow("no REDRESS_RESULT");
  });
});

describe("eventIndexInTx", () => {
  test("is the position in the transaction, not the block log index", () => {
    expect(eventIndexInTx([{ logIndex: 90 }, { logIndex: 88 }, { logIndex: 89 }], 90)).toBe(2);
  });

  test("fails for a log outside the receipt", () => {
    expect(() => eventIndexInTx([{ logIndex: 1 }], 2)).toThrow("not in receipt");
  });
});

describe("assertMatches", () => {
  const row = { txHash: "0x1", logIndex: 1, verdict: "WRONGFUL", redress: "5" } as Row;

  test("accepts an exact match", () => {
    expect(() => assertMatches(row, { verdict: "WRONGFUL", redress: "5" })).not.toThrow();
  });

  test("stops on any difference", () => {
    expect(() => assertMatches(row, { verdict: "WRONGFUL", redress: "6" })).toThrow();
    expect(() => assertMatches(row, { verdict: "AMBIGUOUS", redress: "5" })).toThrow();
  });
});
