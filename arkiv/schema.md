# Arkiv schema

Redress writes four entity types to the Rabdi testnet, chain ID 7794095. The schemas are in [`backend/arkiv.ts`](../backend/arkiv.ts), and values are built by the pure functions in [`backend/entities.ts`](../backend/entities.ts).

Addresses and hashes are lowercased. Numeric attributes are `u64`. Wei stays in the JSON payload as a string, so no precision is lost, and milli-ETH attributes exist for range queries.

**Owner:** the writer wallet `0xD19D988fAe15c6AF0CB18FD5D79bffa41F8c2683` owns every entity. Anyone can write an entity with the same attributes, so readers should filter with `.ownedBy(writer)`, as this app does.

## Entities

### `redress.verdict`: one per liquidation

| Attribute | Type | Indexed | Queried by |
|---|---|---|---|
| `user` | string | Yes | The "Was I wronged?" lookup |
| `incidentId` | string | Yes | The explorer |
| `verdict` | string | Yes | The explorer |
| `redressMilliEth` | u64 | Yes | The explorer, range and sort |
| `block` | u64 | Yes | The explorer, range |
| `txHash`, `logIndex`, `protocol`, `chainId`, `deviationBps`, `srcCount`, `vaultTx` | mixed | Yes | Available |
| `evidenceBzz` | string | No | Empty: Swarm is not built |
| `payload` | bytes | No | Full verdict JSON |

**Expiry:** 180 days.

### `redress.incident`: one per incident

`incidentId`, `protocol`, `startBlock`, `endBlock`, `victims`, `totalRedressMilliEth`, `status`, and the scorecard as `payload`.

**Expiry:** 180 days.

### `redress.claim`: one per address

A true-up claim: the gap between the floor paid and the midpoint estimate. `claimId`, `user`, `kind`, `status`, `amountMilliEth`, `payload`.

**Expiry:** 7 days, and the expiry is the point: a claim window that closes by itself needs no cleanup job.

Nothing pays a true-up today, because the vault pays the floor only. The entity records the gap and the window.

### `redress.recovery`: one per payout

Mirrors the on-chain claim against the liquidator and builder: `liquidationTx`, `liquidator`, `builder`, `status`, `amountMilliEth`, `payload`.

**Expiry:** 90 days.

## Why 180 days and not 365

The PRD planned 365 days. The chain caps a lifetime at 7,884,000 blocks, about 182 days. `extendEntity` can keep a record alive past that.

## Runnable query

No key or wallet is needed to read, but the anonymous budget runs out quickly, so set `ARKIV_ACCESS_KEY` if you have one.

```ts
// bun run query.ts, from the repo root
import { and, eq, gte } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { hexToString } from "viem";
import { Verdicts, arkivReader } from "./backend/arkiv";

const page = await arkivReader()
  .select({ payload: true })
  .from(Verdicts)
  .where(and(eq("verdict", "WRONGFUL"), gte("redressMilliEth", u64(10_000n))))
  .ownedBy("0xD19D988fAe15c6AF0CB18FD5D79bffa41F8c2683")
  .limit(5)
  .fetch();

for (const e of page.entities) console.log(JSON.parse(hexToString(e.payload.value)).user);
```

This lists WRONGFUL verdicts of 10 ETH or more.
