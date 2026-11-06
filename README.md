# Redress

> When an oracle gets it wrong, make people whole in blocks, not weeks.

Redress is an automatic, evidence-based restitution layer for wrongful liquidations caused by oracle misconfigurations or price feed anomalies. It monitors lending protocol liquidations in real time, constructs an independent multi-source price band, calculates the exact provable net loss, and pays victims from a pre-funded vault in the same transaction that records the verdict.

---

## 🏛️ Sponsor Sections & Code Pointers

### 1. Uniswap Foundation (Primary)
- **U1: Uniswap v3 TWAP Oracle Integration**
  - Consumed as an independent on-chain price source within the consensus band.
  - Pointers: [`cre/sentinel-verdict/verdict.ts`](cre/sentinel-verdict/verdict.ts)
- **U3: Uniswap v4 `BandOracleHook`**
  - Native v4 hook recording tick observations and exposing `getBand(key, window)` to give pools manipulation-resistant internal price bands.
  - Pointers: [`contracts/src/hooks/BandOracleHook.sol`](contracts/src/hooks/BandOracleHook.sol)
- **Developer Feedback**: See [`FEEDBACK.md`](FEEDBACK.md) for detailed developer feedback submitted to the Uniswap Foundation form.

### 2. Chainlink CRE (Primary)
- **Chainlink Runtime Environment (CRE) Workflow: `sentinel-verdict`**
  - Log-triggered EVM execution on Aave `LiquidationCall` events.
  - Multi-source price aggregation, consensus threshold checks, and deterministic on-chain reporting.
  - Pointers:
    - Configuration: [`cre/project.yaml`](cre/project.yaml)
    - Workflow Entrypoint: [`cre/sentinel-verdict/main.ts`](cre/sentinel-verdict/main.ts)
    - Verdict & Restitution Math: [`cre/sentinel-verdict/verdict.ts`](cre/sentinel-verdict/verdict.ts)
    - On-chain Settlement Vault: [`contracts/src/RedressVault.sol`](contracts/src/RedressVault.sol)

### 3. Arkiv + Swarm (Third Pick)
- **Arkiv Public Ledger**:
  - Signer & Writer Wallet: TODO-VERIFY, added after the first Arkiv write
  - Runnable query: TODO-VERIFY, added once writes exist (planned queries are in PRD Appendix B)
  - Specification & Design files:
    - [`arkiv/schema.md`](arkiv/schema.md)
    - [`arkiv/friction.md`](arkiv/friction.md)
    - [`arkiv/reach.md`](arkiv/reach.md)
    - [`arkiv/why-arkiv.md`](arkiv/why-arkiv.md)
    - [`arkiv/how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md)
    - [`arkiv/swarm.md`](arkiv/swarm.md)
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
│   ├── onchain.ts
│   ├── verify-onchain.mjs
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

## Verified incident data

Read from chain by `replay/verify-onchain.mjs`. Full output: [`replay/data/verification-report.txt`](replay/data/verification-report.txt). Per-liquidation data: [`replay/data/incident-2026-03-10.json`](replay/data/incident-2026-03-10.json).

| Fact | On-chain value |
|---|---|
| Execution tx | block 24626860, 2026-03-10 11:46:11 UTC (fork block 24626859) |
| Core pool / oracle | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` / `0x54586bE62E3c3580375aE3723C145253060Ca0C2` |
| Prime pool / oracle | `0x4e033931ad43597d96D6bcc25c280717730B58B1` / `0xE3C061981870C0C7b1f3C4F4bB36B95f1F260BE6` (market id "Aave V3 Lido Ethereum") |
| Borrow cap cut | block 24627510 |
| CAPO realignment | block 24628089 |
| E-Mode bonus | 1% in both markets |
| E-Mode liquidation threshold | Core 95.0%, Prime 96.5% |
| Deepest Uniswap v3 pool | `0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa` (0.01% fee) |

### Checked against official docs

| Item | Result | Source |
|---|---|---|
| CRE forwarder, Sepolia | Simulation `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`, production `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`. The vault must switch forwarder between the two | [Forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts) |
| CRE quotas | 15 HTTP calls, 15 EVM reads, 50 KB report, 100-block log queries, per execution. Higher than the PRD figures, so the PRD budget still fits. TODO-VERIFY: read from a search index of the page, confirm on the live page | [Service quotas](https://docs.chain.link/cre/service-quotas) |
| Uniswap Sepolia | PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`; code and activity are in the verification report | [v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments) |
| Arkiv testnet | TODO-VERIFY: the PRD chain ID 7794095 was not found. The Tiramisu RPC answers `eth_chainId` with `0x7614d1`. Confirm against the Mumbai prize page | [Arkiv docs](https://arkiv.dev.golem.network/docs) |

### Differences from the published figures

Data was not adjusted to fit. These are the differences and their causes.

| Published | On-chain | Cause |
|---|---|---|
| 34 accounts | 33 distinct addresses, 34 market positions | `0x5e1b601245b942d99aa924d39e0fbec1786e2170` was liquidated in both Core and Prime. 20 Core + 14 Prime = 34 |
| 34 liquidations implied | 47 WETH-debt events | Some Prime positions were liquidated more than once |
| ~512 ETH loss | 498.27 ETH from `C · rate − X`, 511.60 ETH with the protocol fee | `liquidatedCollateralAmount` excludes the Aave protocol fee. 10.84 wstETH (13.32 ETH) went to the treasury, matching the DAO's 13.32 ETH fee line |
| All E-Mode | 46 of 47 events | One 0.038 wstETH Core position was outside E-Mode |
| LT 95.5% (assumed, PRD Appendix A) | 95.0% Core, 96.5% Prime | The PRD value was an illustrative assumption |

Both totals treat 1 stETH as 1 ETH and are rough checks, not verdicts. Two further wstETH-collateral liquidations in the window had non-WETH debt (0.0034 and 0.0008 wstETH). They are stored in the incident file but are outside these totals.

---

## ⚡ Quickstart

```bash
# 1. Install dependencies
git submodule update --init --recursive
bun install
cp .env.example .env   # then fill it in

# 2. Run tests
bun test
(cd contracts && forge test)

# 3. Re-check on-chain facts and rebuild the incident file
bun run verify
bun run fetch-incident
```

Pinned toolchain: Foundry 1.5.1, solc 0.8.26, forge-std 1.17.0, Bun 1.4.4, viem 2.57.
