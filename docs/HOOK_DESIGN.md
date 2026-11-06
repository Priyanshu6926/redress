# BandOracleHook design

Status: **approved and built.** See "Current state".

## Honest role

The 10 March 2026 incident happened on mainnet, and its Uniswap source was a **v3** wstETH/WETH pool. This hook played no part in it.

- The replay and the Sepolia mirror use the v3 TWAP as source S2. **The hook was not used in them, and we never claim it was.**
- The Sepolia v4 pool is **synthetic**. We create it, fund it, set its starting price and make its swaps. Its price is not market evidence.
- The hook's value is forward-looking: it shows how a v4 market could expose a price band without an external oracle. On a pool with real, independent liquidity it could become one source among several.
- One pool is never enough alone. A band from this hook is one input to the median, with the usual outlier rejection.

## What the hook stores

A ring of 1,024 observations per pool:

| Field | Type | Meaning |
|---|---|---|
| `timestamp` | `uint32` | When the observation was written |
| `tick` | `int24` | The pool's tick before the block's first swap, which is where the previous block ended |
| `tickCumulative` | `int56` | Sum of tick × seconds up to `timestamp`, as in the Uniswap v3 oracle |

Rules:

- At most one observation per block, written by the first swap of that block.
- A swap cannot affect its own block's observation, because the tick is read before it executes.
- Each observation's tick is treated as having held since the previous observation.

## Permission flags

| Flag | Why |
|---|---|
| `afterInitialize` | Writes the first observation, so a new pool has a defined band |
| `beforeSwap` | Records the pre-swap tick |

No other flag is set. The hook takes no fee and returns no delta, so it cannot change a swap's outcome. The address is mined with CREATE2 so its low bits equal exactly these two flags, and the constructor rejects any other address.

## Interface

```solidity
struct Band {
    int24 twapTick;         // time-weighted tick over the covered period
    int24 minTick;          // lowest tick in the window
    int24 maxTick;          // highest tick in the window
    uint32 count;           // observations inside the window
    uint32 coveredSeconds;  // history actually covered, at most `window`
    uint32 lastObservedAt;  // timestamp of the newest observation
}

function getBand(PoolKey calldata key, uint32 window) external view returns (Band memory);
function observationCount(PoolKey calldata key) external view returns (uint16);
```

| Case | Behaviour |
|---|---|
| Pool never initialised with this hook | Reverts `UnknownPool` |
| `window` is zero | Reverts `ZeroWindow` |
| Initialised, no swaps yet | Band at the initial tick, `count` 1 |
| Quiet pool, no swaps in the window | TWAP at the last end-of-block price, `count` 0 |
| Window longer than stored history | Served from what remains; `coveredSeconds` shows the shortfall |

## Manipulation

| Attack | Result |
|---|---|
| Sandwich inside one block | No effect: only block-end prices are recorded |
| One large swap held over a block boundary | Moves the TWAP in proportion to how long it holds, so only slightly over a long window. `minTick` or `maxTick` does show it, which is the purpose of a band |
| Sustained move across many blocks | Moves the TWAP. Capital at risk is the only defence, so thin pools give weak protection |

## Limits

- The hook records only when the pool trades, so a quiet pool gives a stale band. Consumers must check `count`, `coveredSeconds` and `lastObservedAt`.
- A view call in a block with no swap reads the current tick, which is the price an earlier block ended on.
- `getBand` loops over up to 1,024 observations. That is fine for an off-chain or CRE read and too costly for on-chain callers.

## `v4Hook` source type

A new optional entry in the workflow config:

```json
{
  "type": "v4Hook",
  "chain": "ethereum-testnet-sepolia",
  "hook": "0x…",
  "poolKey": { "currency0": "0x…", "currency1": "0x…", "fee": 3000, "tickSpacing": 60, "hooks": "0x…" },
  "windowSec": 1800,
  "minObservations": 5,
  "maxAgeSec": 3600,
  "synthetic": true
}
```

- The band's TWAP tick becomes a price through the existing tick math in `cre/sentinel-verdict/position.ts`.
- It fails closed: fewer than `minObservations`, or older than `maxAgeSec`, means the source is unavailable, as with any stale source.
- `synthetic: true` is copied into the evidence bundle and result, and shown in the UI.

**Keeping it out of the replay.** It is enforced in code rather than by convention:

- Only a new `demo-v4hook` config may contain this source.
- Config validation rejects `v4Hook` in `config.fork.json`, `config.sepolia.json` and any config that targets incident events.
- A test asserts that no `replay.json` row lists a `v4Hook` source.
- The `demo-v4hook` run writes a labelled result to its own file. It never pays from the vault and never enters `replay.json`.

**Demo pool price.** The current demo pool starts at 1:1, so as a wstETH/ETH source it would be rejected as an outlier. A useful test needs a pool started near a realistic ratio. That price would be chosen by us, so the test proves only that the plumbing works, not that the price is independent.

## Tests

With the v4-core test utilities:

- Observations are recorded on swap, once per block, at the pre-swap tick.
- Window queries: time weighting, a window starting mid-interval, old observations dropping out, ring wrap.
- Manipulation: a single large swap moves a long-window TWAP only slightly while `minTick` or `maxTick` shows it, and a same-block sandwich leaves no trace.
- Empty history: every case in the table above.
- Access: only the PoolManager can call the hook, and a wrongly flagged address is rejected.

## Addresses

From the [official deployments page](https://developers.uniswap.org/docs/protocols/v4/deployments), read 2026-11-07. Activity was read from Etherscan the same day: each has at least 100 direct transactions, the latest on 2026-11-06.

| Contract | Address |
|---|---|
| PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| PoolSwapTest | `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee` |
| PoolModifyLiquidityTest | `0x0c478023803a644c94c4ce1c1e7b9a087e411b0a` |
| Universal Router (main table) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| Universal Router 2.1.1 | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` |
| Universal Router 2.1.2 | `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3` |

The hook needs no Universal Router. The demo swaps use `PoolSwapTest`.

## Base contract

The brief asked for `BaseHook` from v4-periphery, but commit `5da22e60` (2026-02-06, "remove hooks and move to hook repo") removed it. Uniswap's own `v4-template` now imports `BaseHook` from OpenZeppelin `uniswap-hooks`, so the hook uses that.

## Current state

| Item | Value |
|---|---|
| Hook | [`0xc555e1ca0a109a1f02d238455ff4feda7ba5d080`](https://sepolia.etherscan.io/address/0xc555e1ca0a109a1f02d238455ff4feda7ba5d080#code), verified on Etherscan |
| Address low bits | `0x1080`: `afterInitialize` (`0x1000`) and `beforeSwap` (`0x80`) only |
| Demo pool | Start tick 2061, about 1.2288 WETH per demo token, a price we chose |
| Band data | 7 observations after 6 swaps; a one-hour read gave TWAP tick 2052, min 1970, max 2080 |
| Superseded | `0x301eb55a7d1e5528771857aceef4714af34b5080`, deployed before review on `IHooks` directly, unused |

**`demo-v4hook` run** (`docs/transcripts/demo-v4hook.txt`, `replay/out/demo-v4hook.json`): one CRE simulation read mainnet and the hook on Sepolia. The hook joined as source S4 at 1.229232, the verdict and redress matched the replay, and only `bandHigh` moved. Nothing was written.

**Limits of that run.** The hook price is current while the event is from March 2026, so it carries the event's timestamp only to pass the staleness check. The read uses the latest block, because this SDK version exports no finalized-block constant. A real DON would need an agreed block.
