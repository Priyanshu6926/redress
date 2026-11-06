# How Redress uses Arkiv

## Filters

| Feature | Query |
|---|---|
| "Was I wronged?" | `user = <address>` |
| Incident explorer | `incidentId = <id>`, with optional `verdict`, a `redressMilliEth` range and a `block` range, sorted by `redressMilliEth` descending |

The filters run on the node, on indexed attributes. Code: [`backend/arkiv.ts`](../backend/arkiv.ts).

Each response says whether Arkiv or the local JSON fallback served it, and the site shows that to the user.

## Ownership

One writer wallet owns every entity. Anyone can create an entity with matching attributes, so reads use `.ownedBy(writer)`. Without that filter a stranger could plant a fake verdict for any address.

## Expiry

| Entity | Expiry | Why |
|---|---|---|
| `verdict`, `incident` | 180 days | The longest round figure under the chain's cap |
| `recovery` | 90 days | A working window for pursuing a claim |
| `claim` | 7 days | The claim window itself |

## What we kept off Arkiv

| Data | Where | Why |
|---|---|---|
| Payout amounts and status | Sepolia vault | Money needs the chain's guarantees |
| Bond and reserve balances | Sepolia contracts | Same |
| Raw evidence | Not stored yet | Swarm is the planned home, and only a hash is on-chain today |
| Private keys | `.env` | Never published |

## Publishing

[`replay/publish-arkiv.ts`](../replay/publish-arkiv.ts) writes in atomic batches of 10 and records each entity key in `replay/out/arkiv.json`, so a failed run resumes without duplicates.
