# Swarm Integration & Evidence Storage

This document covers how Redress splits data between Arkiv and Swarm, providing permanent decentralized evidence packs for oracle mispricing verdicts.

---

## 1. Division of Responsibilities
| Data Type | Storage Layer | Identifier / Location | Rationale |
|---|---|---|---|
| Verdict Metadata | Arkiv | `verdict:{tx}:{index}` | Fast queryable indexed fields |
| Incident Registry | Arkiv | `incident:{id}` | Quick lookups by user and status |
| Raw Debug Traces & Snapshots | Swarm | BZZ Reference Hash | Multi-megabyte raw transaction traces and logs |

## 2. Postage Batch & Reference Details
- **Swarm Postage Batch ID**: `[CONFIGURED_IN_DEPLOYMENT]`
- **Wallet Address**: `[CONFIGURED_SENTINEL_WALLET]`
- **Uploaded Artifacts**:
  - `replay/data/incident-2026-03-10.json` raw debug bundle
  - Consensus price feeds and multi-source oracle snapshot dumps

## 3. Upload & Verification Steps
```bash
# Upload incident bundle to Swarm
bun run backend/swarm.ts --upload incident-2026-03-10

# Read evidence bundle from Swarm
bun run backend/swarm.ts --fetch <SWARM_REFERENCE_HASH>
```

