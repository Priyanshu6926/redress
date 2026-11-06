# Arkiv Schema Specification

This document details the data model, entities, queried fields, owners, and expiry semantics for Redress on Arkiv.

---

## 1. Entity Definitions

### 1.1 `Incident`
Represents an oracle mispricing event detected across protocols.
- **Key**: `incident:{protocol}:{chain_id}:{incident_id}` (e.g., `incident:aave_v3:1:2026-03-10-wsteth`)
- **Fields**:
  - `protocol` (string): Protocol identifier (`aave_v3`)
  - `asset` (string): Faulty asset address
  - `startBlock` (uint64): First detected block with bad oracle pricing
  - `endBlock` (uint64): Resolution block
  - `affectedCount` (uint32): Number of flagged liquidations
  - `totalRestitution` (uint256): Aggregate restitution calculated (wei)
  - `evidenceSwarmRef` (string): Swarm hash containing the raw incident bundle
- **Owner**: Sentinel operator wallet address
- **Expiry**: Never expires (immutable archival record)

### 1.2 `Verdict`
Represents the restitution decision for a single liquidated position.
- **Key**: `verdict:{liquidation_tx}:{log_index}`
- **Fields**:
  - `liquidationTx` (bytes32): Transaction hash of the liquidation
  - `user` (address): Victim address receiving redress
  - `borrowAsset` (address): Debt asset paid out
  - `collateralAsset` (address): Seized collateral asset
  - `netLoss` (uint256): Computed restitution amount in borrow asset
  - `status` (string): `WRONGFUL` | `BENIGN` | `CLAIMED`
  - `payoutTx` (bytes32, optional): On-chain payout transaction hash
- **Owner**: Sentinel / Relayer wallet
- **Expiry**: Never expires

### 1.3 `Claim`
Tracks user claim interactions and recovery states.
- **Key**: `claim:{user}:{verdict_key}`
- **Fields**:
  - `claimant` (address): User claiming recovery
  - `timestamp` (uint64): Claim timestamp
  - `amount` (uint256): Claimed amount
- **Owner**: Claimant user address
- **Expiry**: 365 days (or until settled)

---

## 2. Query Indexing
Arkiv queries used by the Redress Explorer:
- Query verdicts by user address: `user == :address`
- Query open claims by incident: `incident == :incident_id AND status == 'WRONGFUL'`

