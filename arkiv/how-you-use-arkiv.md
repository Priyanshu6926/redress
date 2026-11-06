# How Redress Uses Arkiv

---

## 1. Entity Filters and Indexing
Redress leverages Arkiv's indexed metadata fields:
- `user`: Allows instant lookups by borrower address in the "Was I Wronged?" web portal.
- `incident`: Groups all 34 verdicts from the 2026-03-10 event under a single verifiable incident identifier.
- `status`: Segregates actionable wrongful liquidations from benign liquidations.

## 2. Ownership & Expiry Semantics
- **Incidents & Verdicts**: Owned by the Sentinel consensus signer and set to never expire, preserving the historical safety record of DeFi lending protocols.
- **Claims**: Owned by claimant addresses with configurable expiry to ensure active claims are settled within the vault's solvency window.

## 3. What We Kept Off Arkiv and Why
- **Large RPC traces & raw debug logs**: Full multi-megabyte transaction debug traces are pinned to Swarm to keep Arkiv entities lean, fast, and low cost. Arkiv stores the Swarm content hash reference (`evidenceSwarmRef`).
- **Private keys and pre-computation states**: Off-chain ephemeral states remain local to the sentinel runner.

