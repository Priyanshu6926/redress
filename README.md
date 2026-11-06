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

## Trust model of this demo

- **Anyone can forge a report against a simulation vault.** Simulated runs go through `MockKeystoneForwarder`, including the Sepolia mirror. A fork test shows it delivers a report from any sender with no signatures, an `eth_call` shows the same on Sepolia, and it supplies no workflow identity, so the vault cannot tell a forged report from a real one. This is why the demo vault only ever holds test tokens. Production forwarding uses the signature-checking `KeystoneForwarder` and needs a deployed workflow.
- **The vault checks arithmetic, not facts.** It cannot see mainnet, so it trusts the report for the position, band, bonus, verdict and finality. In production that trust rests on CRE consensus.

## Sepolia public mirror

All 47 incident liquidations ran through `cre workflow simulate --broadcast`, reading mainnet history and writing to Sepolia. The vault paid 33 addresses a total of 473.295500496135010048 test WETH, equal to the offline replay's floor to the wei. These are test tokens, not compensation.

| Contract | Address |
|---|---|
| `RedressVault` | [`0x73278c1e2b1a2d9d129955369c32aa4aeef4fbf9`](https://sepolia.etherscan.io/address/0x73278c1e2b1a2d9d129955369c32aa4aeef4fbf9#code) |
| `MockWETH` | [`0xa193cae8762aeedcbf4d73c96369b54e5100fba4`](https://sepolia.etherscan.io/address/0xa193cae8762aeedcbf4d73c96369b54e5100fba4#code) |

Every vault transaction is in `replay/out/mirror-sepolia.json`, and the first event's transcript is in `docs/transcripts/sepolia.txt`. Each run was a local simulation with one node, so DON consensus was not exercised. The historical liquidations were replayed from their logs, not re-executed.

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

### Off-chain price sources (S3)

`replay/data/offchain-prices.json` holds two series fetched by `replay/fetch-offchain.ts`, stored as fetched with URLs, fetch date and timestamps. Nothing was removed by hand: the engine's outlier rejection decides what enters the band.

| Series | Result | Overlap with S1 and S2 |
|---|---|---|
| [DefiLlama](https://coins.llama.fi) `batchHistorical`, wstETH USD / WETH USD | Used. Median 18.5 bps from the Lido rate | **Provenance unconfirmed.** A [2022 article](https://www.chaincatcher.com/en/article/2079733) says DefiLlama starts from CoinGecko and falls back to DEX markets including Uniswap, so a Uniswap input cannot be ruled out. Measured: 13 bps median from S2, and its deviation from Lido has a 0.12 correlation with S2's, so it is not a copy of that pool. It is also 14.5 bps from the Lido rate on a wstETH/stETH basis, so it is not the Lido rate either |
| [CoinGecko](https://api.coingecko.com) `market_chart/range`, wstETH in ETH | **Rejected on every incident event.** Median 1,394 bps from the Lido rate. The stored series reads 1.02 to 1.08 ETH against a true ~1.23, in February as well as March, while current tickers and its stETH series look normal | CoinGecko aggregates markets. Its current wstETH tickers include Uniswap v3 wstETH/WETH, so this would overlap S2 if it were usable |

Limits of the DefiLlama series:

- It has one point every 30 to 60 minutes, so all 47 incident events share the same sample.
- Its two legs are up to 7 minutes apart (114 seconds at the incident), so ETH movement between them adds noise to the ratio.
- With CoinGecko rejected, it is the only off-chain source in the band, so `default` has one off-chain voice, not two.
- CoinGecko's public API refuses dates older than 365 days, so 9 older control timestamps have no CoinGecko point.

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

## Running the replay and mirror

```bash
make fork-up        # terminal 1: local fork. Without make: bash replay/fork-up.sh
make snapshot       # terminal 2: serves the off-chain snapshot to the workflow
make deploy-fork    # vault on the fork, funded with 3,000 WETH
make replay         # every incident event through the CRE workflow on the fork
make deploy-sepolia # MockWETH and vault on Sepolia, verified on Etherscan
make mirror         # every incident event through the workflow, paying on Sepolia
make scorecard      # rebuilds replay/out/replay.json with the vault transactions
```

`replay` and `mirror` resume from `replay/out/mirror-<target>.json`, so a failed run never pays twice, and they stop if the workflow's result differs from the offline replay by one wei. The fork is log replay: the workflow reads historical state and only the vault runs on the fork.

`replay/out/rehearsal-fork.json` is a rehearsal, not a CRE run. It sends the encoded reports straight through the mock forwarder, and it never feeds `vaultTx`.

## Frontend data contract

- `docs/replay.schema.json`: the versioned contract.
- `replay/out/replay.json`: real data. `vaultTx` is `null` until a real payout exists.
- `replay/out/replay.mock.json`: synthetic data covering every verdict and page state, with `mock: true`.
- `web/lib/lookup.ts`: address lookup for "Was I wronged?". It reads the JSON today, and Arkiv can replace it behind the `VerdictSource` interface.

`redressFloor` is what is paid. `redressMidpoint` is for comparison with the DAO figure only.

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
