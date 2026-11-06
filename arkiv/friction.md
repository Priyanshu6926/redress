# Arkiv friction report

Written from what happened while building this, in the order we hit it.

## 1. Finding the current testnet took reading the SDK source

Searching for the testnet returned Mendoza, Kaolin and Tiramisu, each with a different RPC and SDK version. The Mumbai prize page gave chain ID 7794095. An earlier check of ours, against the Tiramisu RPC, could not confirm that ID.

The answer was in `dist/chains/index.js` of `@arkiv-network/sdk` 1.0.1: the testnet is now **Rabdi**. Older guides still rank highly in search and do not say they are out of date.

**What would help:** one page, linked from every older guide, naming the current testnet.

## 2. A rate limit looked like a hang

Writes worked. Then every filtered query stopped answering, while reading an entity by key took 326 ms. We lost time assuming our query was wrong.

The cause was `HTTP 429 ANON_COST_LIMITED`. viem's default retries sat on it silently, so `fetch()` never returned or failed in any useful time. We only saw the 429 by logging raw traffic with `onFetchRequest` and `onFetchResponse`.

Two more surprises:

- Reading by key still worked, so the budget looks query-specific.
- The budget came back by itself. After the publish, about an hour later, anonymous queries answered again. We do not know the refill rate, so a demo cannot rely on it.
- The SDK does print a warning about the public endpoint, but it says "heavily rate limited", which reads as slower rather than stops.

**What would help:** have the query client surface a 429 as a clear error straight away, and turn off retries on it by default.

**What we changed:** the reader now uses no retries and an 8-second timeout, so the app falls back to JSON instead of freezing.

## 3. A bare bigint is a `u256`

Our columns were `u64`, and our values were bigints. The write failed with:

```
SchemaMismatchError: Column "n": a u64 column, but the value is a u256. Write u64(...) around the value.
```

The message is excellent and told us the fix. But a bigint going into a `u64` column feels like it should work, and the same wrapping is needed in `gte("block", u64(...))`, which is easy to miss. The README's example uses `dec`, so it does not show this case.

## 4. Our planned expiry was impossible

The PRD planned 365 days for verdicts. The error was clear:

```
InvalidExpiryError: a lifetime of 15768000 blocks is longer than the chain's maximum lifetime of 7884000 blocks (about 182 days)
```

It would have saved a design change to see this limit next to `expiresIn` in the data-model docs. For a public record of restitution, about six months is short, so anyone relying on Arkiv for this must plan renewals with `extendEntity`.

## What worked well

- **`executeBatch`** wrote many entities of different schemas atomically, which made an interrupted publish safe to resume.
- **`defineSchema`** caught our type mistakes before any transaction was sent.
- **Error messages** named the exact fix in both cases above.
- A single write confirmed in under 3 seconds.
- Publishing all 128 entities took 13 batch transactions and about 0.06 tGLM.
