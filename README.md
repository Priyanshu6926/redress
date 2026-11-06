# Redress

> When an oracle gets it wrong, make people whole in blocks, not weeks.

Redress is an automatic, evidence-based restitution layer for wrongful liquidations caused by oracle misconfigurations or price feed anomalies. It monitors lending protocol liquidations in real time, constructs an independent multi-source price band, calculates the exact provable net loss, and pays victims from a pre-funded vault in the same transaction that records the verdict.

---

## 🏛️ Sponsor Sections & Code Pointers

### 1. Uniswap Foundation (Primary)
- **U1: Uniswap v3 TWAP Oracle Integration**
  - Consumed as an independent on-chain price source within the consensus band.
  - Pointers: [`cre/sentinel-verdict/verdict.ts`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/cre/sentinel-verdict/verdict.ts#L1-L60)
- **U3: Uniswap v4 `BandOracleHook`**
  - Native v4 hook recording tick observations and exposing `getBand(key, window)` to give pools manipulation-resistant internal price bands.
  - Pointers: [`contracts/src/hooks/BandOracleHook.sol`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/contracts/src/hooks/BandOracleHook.sol#L1-L55)
- **Developer Feedback**: See [`FEEDBACK.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/FEEDBACK.md) for detailed developer feedback submitted to the Uniswap Foundation form.

### 2. Chainlink CRE (Primary)
- **Chainlink Runtime Environment (CRE) Workflow: `sentinel-verdict`**
  - Log-triggered EVM execution on Aave `LiquidationCall` events.
  - Multi-source price aggregation, consensus threshold checks, and deterministic on-chain reporting.
  - Pointers:
    - Configuration: [`cre/project.yaml`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/cre/project.yaml#L1-L16)
    - Workflow Entrypoint: [`cre/sentinel-verdict/main.ts`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/cre/sentinel-verdict/main.ts#L1-L10)
    - Verdict & Restitution Math: [`cre/sentinel-verdict/verdict.ts`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/cre/sentinel-verdict/verdict.ts#L1-L60)
    - On-chain Settlement Vault: [`contracts/src/RedressVault.sol`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/contracts/src/RedressVault.sol#L75-L108)

### 3. Arkiv + Swarm (Third Pick)
- **Arkiv Public Ledger**:
  - Signer & Writer Wallet: `0x[CONFIGURED_IN_DEPLOYMENT]`
  - Runnable query: `query { verdicts(where: { user: "0x..." }) { liquidationTx netLoss status } }`
  - Specification & Design files:
    - [`arkiv/schema.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/arkiv/schema.md)
    - [`arkiv/friction.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/arkiv/friction.md)
    - [`arkiv/reach.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/arkiv/reach.md)
    - [`arkiv/why-arkiv.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/arkiv/why-arkiv.md)
    - [`arkiv/how-you-use-arkiv.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/arkiv/how-you-use-arkiv.md)
    - [`arkiv/swarm.md`](file:///d:/CAREER/Hackathon/ETHGlobal%20Mumbai/redress/arkiv/swarm.md)
- **Swarm Evidence Storage**:
  - Full transaction execution traces and price snapshot bundles stored on Swarm, referenced by `evidenceHash` on-chain and `evidenceSwarmRef` in Arkiv.

---

## 📁 Repository Structure

```
redress/
├── README.md                 # sponsor sections with file+line pointers
├── PRD.md                    # full product requirements document
├── FEEDBACK.md               # Uniswap requirement feedback
├── LICENSE                   # MIT
├── arkiv/                    # Arkiv requirement files
│   ├── schema.md
│   ├── friction.md
│   ├── reach.md
│   ├── why-arkiv.md
│   ├── how-you-use-arkiv.md
│   └── swarm.md
├── contracts/
│   ├── src/
│   │   ├── RedressVault.sol
│   │   ├── VerdictMath.sol
│   │   ├── OperatorBond.sol
│   │   ├── RecoveryLedger.sol
│   │   └── hooks/
│   │       └── BandOracleHook.sol
│   ├── test/
│   │   ├── unit/
│   │   ├── fuzz/
│   │   ├── invariant/
│   │   └── fork/
│   └── script/
│       ├── DeployVault.s.sol
│       ├── DeployHook.s.sol
│       └── MineHookAddress.s.sol
├── cre/
│   ├── project.yaml
│   └── sentinel-verdict/
│       ├── main.ts
│       ├── sources/
│       ├── verdict.ts
│       ├── config.fork.json
│       └── config.sepolia.json
├── replay/
│   ├── data/
│   │   └── incident-2026-03-10.json
│   ├── fetch-incident.ts
│   ├── fork-up.sh
│   ├── replay.ts
│   └── scorecard.ts
├── backend/
│   ├── watcher.ts
│   ├── arkiv.ts
│   ├── swarm.ts
│   └── api.ts
├── web/                      # Next.js app
└── .github/workflows/
    └── ci.yml
```

---

## ⚡ Quickstart

```bash
# 1. Install dependencies
bun install

# 2. Compile contracts
cd contracts
forge build

# 3. Run replay on local fork
cd ../replay
./fork-up.sh
bun run replay.ts
```

