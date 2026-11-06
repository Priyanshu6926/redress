# Arkiv Friction Report

Honest feedback from building Redress with Arkiv at ETHGlobal Mumbai.

---

## 1. What Worked Smoothly
- **Entity Key-Value Flexibility**: Defining structured entities (`incident`, `verdict`, `claim`) with metadata tags was straightforward.
- **Query Semantics**: Filtering entities by composite keys and tags made building the "Was I Wronged?" frontend query painless.

## 2. Friction Points Encountered
- **Error Messages**: Indexing delay or malformed payload errors were occasionally opaque in the testnet RPC responses.
- **SDK TypeScript Types**: Some optional payload parameters were untyped or required explicit casting.
- **Batch Insertion Throughput**: Rapidly recording 34 verdicts from the incident replay required throttling to avoid testnet rate limits.

## 3. High-Impact Suggestions
- Provide native client-side batching helpers in `@arkiv-network/sdk`.
- Add an interactive testnet query sandbox / explorer for verifying entity state during hackathon builds.

