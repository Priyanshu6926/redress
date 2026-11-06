# Redress — Product Requirements Document

**Working name:** Redress
**Tagline:** When an oracle gets it wrong, make people whole in blocks, not weeks.
**Version:** 1.0 · 6 Nov 2026 · ETHGlobal Mumbai · team of 3
**Sponsor picks:** Uniswap Foundation (primary), Chainlink CRE (primary), Arkiv + Swarm bonus (third pick)
**License:** MIT, open source from the first commit

---

## 0. How to read this document

| Tag | Meaning |
|---|---|
| `[PRIMARY]` | From a primary source: Aave governance forum, official sponsor pages, official docs. |
| `[REPORTED]` | From secondary sources (news, blogs, X threads). Unconfirmed until checked on-chain. |
| `[DERIVED]` | Our own arithmetic from `[PRIMARY]` or `[REPORTED]` numbers. |
| `[VERIFY]` | Must be confirmed on Etherscan or in official docs before we rely on it. Section 17 lists all of them. |
| `[DECISION]` | A design choice we made. Change it only with a reason. |

**Etherscan note.** The research tools used for this PRD could not open Etherscan pages (the fetch was refused), so no address or hash below was read from Etherscan directly. Every on-chain fact is either cited from a forum or docs source, or tagged `[VERIFY]`. Section 17 contains a script that pulls and checks all of it. Running it is the first task of the hackathon.

---

## 1. Executive summary

**What it is.** Redress is an automatic, evidence-based restitution layer for liquidations caused by oracle errors. It watches lending-protocol liquidations, rebuilds an independent price band from several sources (Uniswap TWAP, Lido's fundamental exchange rate, Chainlink data, off-chain aggregators through CRE consensus), proves whether each liquidation was wrongful, computes the borrower's exact net loss, and pays it from a pre-funded vault in the same transaction that records the verdict. No governance vote, no spreadsheet, no human step in the payout path.

**Why now.** Oracle-driven wrongful liquidations keep happening and are always fixed after the fact by slow, manual governance. On 10 March 2026 Aave's wstETH CAPO misconfiguration liquidated about 10,938 wstETH across 34 accounts. The DAO's refund was 512.19 ETH, approved and paid roughly three weeks later, with no public per-user accounting.

**The hero.** "10 March 2026, replayed." We re-execute the real transactions on a mainnet fork. Redress flags all 34 accounts as wrongful, computes a total within about 0.3% of the DAO's number, pays victims within blocks, and publishes per-user evidence anyone can query.

**What is honest about it.** Blockchain finality means a liquidation cannot be undone. Redress performs an economic reversal: it restores each victim's net worth (collateral lost minus debt relieved), paid in the debt asset. It does not pause Aave or alter Aave's oracle, so it cannot conflict with CAPO's protective role.

**Sponsor fit.**
- **Uniswap:** the Uniswap v3 wstETH/WETH TWAP is one independent price source; a new v4 `BandOracleHook` gives v4 pools a native price band; optional swap settlement through the Universal Router.
- **Chainlink:** a CRE workflow, log-triggered, with multi-source reads, consensus, and an onchain report that executes the payout.
- **Arkiv (+ Swarm):** a public, queryable ledger of verdicts, incidents, and recovery claims, with evidence bundles on Swarm.

---

## 2. Problem

### 2.1 What happened on 10 March 2026

| Fact | Value | Tag |
|---|---|---|
| Component | wstETH CAPO risk oracle, Aave v3 Ethereum **Core** and **Prime** instances | `[PRIMARY]` |
| Root cause | `snapshotRatio` could rise only 3% per 3 days on-chain, so it was set to ~1.1919 instead of the target ~1.2282, while `snapshotTimestamp` (1772535647, which is 2026-03-03 11:00:47 UTC `[DERIVED]`) assumed the full 7-day-old anchor | `[PRIMARY]` |
| Effect | CAPO cap computed ~1.1939 against a live rate ~1.2288, an effective drop of ~2.85% | `[PRIMARY]` |
| Liquidations | ~10,938 wstETH, 34 accounts, E-Mode, positions with health factor below ~1.0288 | `[PRIMARY]` |
| Volume | ~$26M to $27.8M depending on source | `[REPORTED]` |
| Value moved to liquidators | ~382 ETH from the price gap plus ~116 ETH in bonuses and fees (post-mortem); ARFC table: 382.76 ETH oracle profit + 129.72 ETH bonus | `[PRIMARY]` |
| Protocol bad debt | None | `[PRIMARY]` |
| Detection | LlamaRisk says it detected the anomaly within minutes | `[PRIMARY]` |
| Containment | Borrow cap cut to 1; `snapshotRatio` manually realigned by Risk Steward | `[PRIMARY]` |

Note the early public figure of "345 ETH loss" (Chaos Labs CEO tweet, reported by news) differs from the later 512 ETH figure in the governance documents. We use the governance numbers.

### 2.2 How it was remedied, and what was wrong with the remedy

| Date (2026) | Event | Source |
|---|---|---|
| 10 Mar | Incident; post-mortem posted 19:50 UTC | `[PRIMARY]` |
| 11 Mar | Direct-to-AIP refund proposal: **512.19 ETH** total (513.19 ETH allowance incl. 1 ETH goodwill); net DAO cost ~357.56 ETH after recoveries (141.60 ETH from a builder, 13.32 ETH fees) | `[PRIMARY]` |
| 12 Mar | A further 41.62 WETH recovered from a searcher, net cost ~316.94 ETH | `[PRIMARY]` |
| 26 Mar | A commenter notes the AIP executed but no funds had moved | `[PRIMARY]` |
| 1 Apr | Funds distributed; commenters note no per-user accounting and one payment ~20 WETH short | `[PRIMARY]`, claims by commenters |

Governance threads also raised moral hazard (the DAO becoming a bailout fund for service-provider errors), process concerns, and the lack of a post-distribution audit mechanism. Our reading: **speed, transparency, determinism, and accountability were all missing, and none of them needed to be human.**

### 2.3 It is a pattern, not a one-off

| Incident (2026) | What happened | Remedy | Tag |
|---|---|---|---|
| Moonwell cbETH (Feb) | ~181 Base borrowers, ~$2.68M net losses from liquidations unrelated to user error | Governance compensation framework | `[REPORTED]` |
| Aave wstETH CAPO (Mar) | 34 accounts, ~512 ETH of user loss | DAO refund, ~3 weeks | `[PRIMARY]` |
| Interlay / Hyperbridge (Apr) | Compensation claim for wrongful liquidation caused by oracle failure | Democracy referendum | `[REPORTED]` |
| Vesu (Sep) | 47 positions, ~$3M collateral, ~2 minutes of faulty price data; liquidations could not simply be reversed due to finality | Manual refund process | `[REPORTED]` |

### 2.4 Why existing mechanisms do not close the gap

| Mechanism | What it does | Why it does not fix this |
|---|---|---|
| Chainlink SVR | Recaptures oracle-extractable value from liquidations for the integrating protocol | Revenue goes to the protocol and Chainlink, not to wrongly liquidated borrowers |
| Aave Umbrella | First-loss insurance fund for protocol bad debt | There was no bad debt; users bore the loss |
| Nexus Mutual and similar | Covers bad debt from liquidation failure | Does not cover wrongful-liquidation losses of borrowers |
| A downward-price circuit breaker | Would pause liquidations on anomalies | Chaos Labs argues it could interfere with CAPO's core protective function; it also needs protocol-level change |
| Governance refunds | Make users whole | Slow, manual, discretionary, no per-user ledger |

### 2.5 The gap, in one sentence

There is no automatic, evidence-based, per-user, onchain restitution path for wrongful liquidations, and it can be built as an independent layer without touching the lending protocol.

*(Prior-art caveat: this comes from a limited search. A judge may know of something we missed; the pitch states the combination, not "first ever".)*

---

## 3. Vision, principles, non-goals

**Vision.** Any lending market can be backstopped by a vault that pays victims of oracle errors within blocks, using public evidence anyone can re-verify.

**Principles**
1. **Evidence before payment.** No payout without a reproducible verdict from several independent sources.
2. **Pay only what is provable.** Payouts use the lower bound of the loss interval across the price band, never the midpoint or maximum, so the system cannot be tricked into overpaying.
3. **No human in the payout path.** Humans set parameters (under a timelock) before an incident. They do not approve payouts during one.
4. **Window, not gate.** The core works read-only on top of an existing protocol, with no permission from it.
5. **Everything public.** Every verdict has an onchain record, a queryable ledger entry, and a content-addressed evidence bundle.
6. **Accountability by design.** Oracle operators can post bonds that pay out first.

**Non-goals (explicit)**
- Not reversing or pausing Aave state; not a circuit breaker; not replacing CAPO.
- Not compensating market-driven liquidations (those are valid by definition).
- Not covering protocol over-pricing events (oracle too high), which are a bad-debt risk, not a borrower-harm case. Those are logged as anomalies only.
- Not legal or financial advice. Not a production mainnet vault in this hackathon (testnet and fork only).

---

## 4. Users and use cases

| Persona | Need | What Redress gives them |
|---|---|---|
| **Victim borrower** | Know if I was wrongly liquidated and get my money back | Address lookup, verdict, payout, evidence link |
| **Protocol or DAO risk team** | Fast, fair, auditable remedy without a governance sprint | Automatic verdicts, per-user ledger, reserve and coverage dashboard |
| **Oracle operator (risk service provider)** | Credible skin in the game | Bond that pays victims first when their oracle is at fault |
| **Honest liquidator** | Avoid being lumped in with glitch exploiters | Verdicts distinguish valid liquidations (zero payout) from wrongful ones |
| **Researcher or auditor** | Verify claims independently | Public SQL-like queries, content-addressed evidence, open-source formulas |
| **ETHGlobal judges** | See a real incident replayed and a working system | One-command replay, hosted ledger, clear sponsor integration points |

---

## 5. Solution overview

### 5.1 Integration modes

| Mode | What it is | Needs protocol permission? | Status |
|---|---|---|---|
| **Window (Observer)** | Read-only watcher on the existing protocol's `LiquidationCall` events; verdicts and payouts from the Redress vault | No | **MVP, shipped** |
| **Guard** | A liquidation router that escrows seized collateral for a short window so a wrongful verdict can claw back the excess | No (liquidators opt in) | Roadmap |
| **Native** | Lending protocol calls Redress for conditional-finality settlement or routes liquidation bonus into the reserve | Yes | Roadmap |

### 5.2 Lifecycle of one liquidation

```
1. DETECT     LiquidationCall event on Aave Pool (Core/Prime)             [CRE EVM log trigger]
2. GATE       Oracle price vs independent band (cheap check)               [τ in bps]
3. VERIFY     Rebuild the band from >= 3 independent sources               [CRE reads + HTTP + consensus]
4. QUANTIFY   Interval health factor -> verdict -> provable-floor redress  [pure function]
5. ATTEST+PAY CRE report -> RedressVault.onReport -> payout to victim      [same transaction]
6. RECOVER    Record claims against liquidators/builders; bond slashing    [RecoveryLedger]
7. PUBLISH    Verdict + evidence to Arkiv (+ Swarm bundle)                 [public, queryable]
```

Targets: attestation within 2 blocks (~24 s) of the liquidation's inclusion, payout in the same transaction as the attestation `[DECISION]`. Measured in blocks in the replay scorecard (Section 8.4).

### 5.3 System picture

```
                          ┌────────────────────────────────────────────┐
   Aave v3 Pool ──events─▶│  CRE workflow  "sentinel-verdict"          │
 (Core / Prime)           │   reads: AaveOracle, Lido rate, Chainlink, │
                          │          Uniswap v3 TWAP / v4 Band hook    │
   Uniswap pools ─reads──▶│   http : 2 off-chain price aggregators     │
   Lido wstETH  ─reads───▶│   consensus (median) → verdict + amounts   │
   Chainlink feeds ──────▶│                                            │
                          └───────────────┬────────────────────────────┘
                                          │ report (< 1 KB)
                                          ▼
                       ┌───────────────────────────────────┐        ┌───────────────┐
                       │ RedressVault  (IReceiver)         │──pay──▶│ Victim wallet │
                       │  bond → reserve → treasury        │        └───────────────┘
                       │  RecoveryLedger, verdict registry │
                       └───────────────┬───────────────────┘
                                       │ events
                    ┌──────────────────┴───────────────────┐
                    ▼                                      ▼
          Arkiv entities (verdicts,               Frontend: Replay Theater,
          incidents, claims) + Swarm bundles      Live Monitor, "Was I wronged?"
```

---

## 6. Core engine (the hero)

This section is the product. Everything else exists to run it, show it, or fund it.

### 6.1 Notation

| Symbol | Meaning |
|---|---|
| `u` | Liquidated borrower |
| `c`, `d` | Collateral asset, debt asset of the liquidation |
| `X` | `debtToCover`: debt repaid by the liquidator (units of `d`) |
| `C` | `liquidatedCollateralAmount`: collateral seized (units of `c`) |
| `b` | Liquidation bonus applicable to the position (e.g. 1% in E-Mode) |
| `p_c^o`, `p_d^o` | Prices Aave's oracle used at the block |
| `[p_c^L, p_c^H]` | Independent price band for the collateral |
| `[p_d^L, p_d^H]` | Independent price band for the debt asset |
| `A`, `D` | Borrower's collateral and debt balances just before this liquidation |
| `LT` | Effective liquidation threshold (E-Mode value if the user is in an E-Mode category) |
| `τ` | Gate tolerance in basis points |
| `HF(p)` | `(A · p_c · LT) / (D · p_d)` |

Prices are expressed in one numeraire per market (ETH for ETH-correlated E-Mode, USD otherwise).

### 6.2 Independent price band

**Sources for the incident class (wstETH priced in ETH):**

| # | Source | How it is read | Notes |
|---|---|---|---|
| S1 | Lido fundamental rate | `wstETH.stEthPerToken()` at the block, times a stETH/ETH market value (Chainlink stETH/ETH feed, which has a coarse 2% deviation threshold, so only used as a sanity multiplier) | Deterministic and on-chain. This is the rate CAPO caps, so S1 alone is never enough `[DECISION]` |
| S2 | Uniswap v3 wstETH/WETH TWAP | `observe([window, 0])` on the deepest pool (selected by script, Section 17) | Market truth, manipulation-resistant with a 30-minute window |
| S3 | Off-chain aggregator #1 | CRE HTTP client (for example a public price API) | Gives independence from on-chain sources |
| S4 | Off-chain aggregator #2 | CRE HTTP client | Second off-chain opinion |

Other markets get their own source sets through a config file. Chainlink data feeds are used wherever a feed exists.

**Procedure**
1. Fetch all sources aligned to the liquidation block's timestamp. Drop any source older than the staleness limit.
2. Compute the median `m`.
3. Drop outliers: anything further than `ε_out` from `m` (default 100 bps).
4. Require at least `minSources` survivors (default 3). Otherwise the result is `INCONCLUSIVE`.
5. Band = `[min, max]` of survivors, widened by margin `μ` (default 10 bps) on each side.
6. Confidence = survivors / sources queried.

**Direction rule `[DECISION]`.** Redress only acts when Aave's price is *harmful to the borrower*: collateral priced below the band, or debt priced above it. Oracle values above the band for collateral are logged as `OVERPRICED` anomalies for alerting and trigger no payout.

### 6.3 Anomaly gate (cheap pre-filter)

```
gate = ( p_c^o < p_c^L · (1 − τ) )  OR  ( p_d^o > p_d^H · (1 + τ) )
```

- Default `τ` = 75 bps for ETH-correlated pairs; per-asset config. For volatile assets `τ` must exceed the feed's own deviation threshold plus market noise `[DECISION]`.
- Incident check: oracle 1.193957 against market 1.228849 is a 2.84% gap `[DERIVED]`, about 38 times `τ`.
- If the gate is false, the liquidation is recorded as `VALID` without the expensive verdict path. In live mode this keeps CRE usage low.

### 6.4 Interval verdict

Each liquidation's pre-state is rebuilt from `A` and `D` at block `B-1`, adjusted by earlier liquidations of the same user in the same block (ordered by block and log index): `A_k = A_0 − ΣC_prev`, `D_k = D_0 − ΣX_prev`.

```
HF_best  = HF(p_c^H, p_d^L)      // most favourable to the borrower
HF_worst = HF(p_c^L, p_d^H)      // least favourable to the borrower

if band is INCONCLUSIVE                    → INCONCLUSIVE   (no payout, re-evaluated later)
else if HF_worst >= 1 + ε_h                → WRONGFUL       (healthy at every price in the band)
else if HF_best  <  1                      → VALID or EXCESS (liquidatable at every price in the band)
else                                       → AMBIGUOUS      (band straddles the threshold)
```

`ε_h` = 10 bps safety margin. A `VALID` liquidation is promoted to `EXCESS` if the seized collateral exceeds the entitlement at independent prices (Section 6.5).

Why intervals: the verdict never depends on a single price. If any price inside the band would have made the liquidation legitimate, Redress does not call it wrongful.

### 6.5 Redress amount: the provable floor

Net-worth loss of the borrower is the collateral value taken minus the debt value relieved:

```
Loss(p) = C · p_c − X · p_d
```

Redress pays the **minimum of that loss across the band**:

```
WRONGFUL:   Redress = max(0, C · p_c^L − X · p_d^H)
EXCESS:     Entitlement = X · p_d^H · (1 + b)
            Redress     = max(0, C · p_c^L − Entitlement)
AMBIGUOUS:  Redress = same EXCESS formula (pay the provable excess only)
VALID:      Redress = 0
```

- Paid in the debt asset (WETH in the incident) because that is what the DAO paid `[DECISION]`.
- **True-up (Should).** After the TWAP window closes, a second report may pay `Loss(median) − already paid`, capped at the upper bound of the loss interval. In the incident the band is narrow (well under 0.1% `[DECISION target]`), so floor ≈ median.

### 6.6 Back-of-envelope reproduction of the DAO refund `[DERIVED]`

Using the public aggregate figures (E-Mode ETH-correlated bonus inferred as 1%; checked below):

```
C        = 10,938 wstETH
p_true   = 1.228849        (market rate quoted by sources)
p_oracle = 1.193957        (rate Aave used)

Oracle profit = C · (p_true − p_oracle)           = 381.65 ETH   (DAO table: 382.76; −0.29%)
X             = C · p_oracle / (1 + b), b = 1%    = 12,930.2 ETH
Bonus value   = X · b                              = 129.30 ETH   (DAO table: 129.72; −0.32%)
Net loss      = C · p_true − X                     = 510.95 ETH   (DAO table sum 512.48: −0.30%; headline 512.19: −0.24%)
Redress / collateral value                         ≈ 3.8%
```

A 1.05% or 2% bonus does not fit (517 or 638 ETH), which is the evidence for 1%. `[VERIFY]` the E-Mode bonus on-chain. The same formula as the DAO's manual accounting, now automatic and per user. The real backtest replaces these aggregates with 34 per-liquidation computations.

### 6.7 Vault payout rules

| Rule | Value |
|---|---|
| Authorization | Only reports delivered by the CRE forwarder (Receiver pattern from CRE templates) `[VERIFY forwarder address]` |
| Waterfall | 1) the oracle operator's bond for the implicated adapter, 2) shared reserve, 3) treasury top-up line (off by default) |
| Idempotency | One payout per `(txHash, logIndex)`; replays are rejected |
| Per-event cap | Redress ≤ value of `C` at `p_c^L` (never more than what was seized) |
| Epoch cap | Global payout cap per epoch (default 20% of reserve) as an automatic circuit breaker |
| Finality | Pay only after `N` block confirmations (default 2) `[DECISION]` |
| Recipient | The `user` field of the on-chain event only. No claims, no addresses supplied by anyone else |
| Emergency | A multisig pause exists as a safety valve but is not part of any normal flow and is not used in the demo |
| Parameters | `τ`, `μ`, caps and source lists change only through a timelock |

### 6.8 Recovery and accountability

- **OperatorBond.** An oracle operator (risk service provider, demo account in our replay) posts a bond against specific adapters. Incidents attributed to that adapter (via `AaveOracle.getSourceOfAsset`) draw from the bond first. This answers the governance complaint that service providers carry no consequences.
- **RecoveryLedger.** Each payout opens a `RecoveryClaim` against the liquidator and block builder addresses that benefited. The DAO recovered 141.6 ETH from a builder and 41.62 WETH from a searcher by hand; Redress makes those claims visible and trackable and automatically re-credits the reserve when funds arrive (`receiveRecovery`).
- **Optional liquidator bond (Roadmap).** Registered liquidators could post a bond slashed for wrongful liquidations, enabling clawback at the source.

### 6.9 Threat model

| Threat | Mitigation |
|---|---|
| Attacker manipulates one price source to trigger payouts | Median of ≥3 independent sources, outlier rejection, band logic, Uniswap TWAP window |
| Attacker manipulates Uniswap TWAP | Long window; TWAP is one source out of several; a manipulated outlier is rejected |
| Fake "victim" claims | No claims at all: recipient comes only from the on-chain event |
| Draining the reserve with many false positives | Per-event cap, epoch cap, gate, provable-floor payout |
| Forged reports | Forwarder-only entry; CRE consensus |
| Source outage | `INCONCLUSIVE`, no payout, automatic re-evaluation |
| Chain reorgs | Confirmation delay `N` |
| Double payment | `(txHash, logIndex)` idempotency |
| Real market crash mistaken for glitch | Independent band falls with the market; gate stays closed; verdict `VALID` |
| Governance capture of parameters | Timelock, caps, public parameter history |
| Reputation: naming entities | Neutral wording ("oracle operator (demo)"), facts cited to primary sources |

---

## 7. Architecture and stack

### 7.1 Components

| Layer | Component | Tech |
|---|---|---|
| Contracts | `RedressVault` (receiver, payout, waterfall), `VerdictMath` library, `OperatorBond`, `RecoveryLedger`, `BandOracleHook` (Uniswap v4) | Solidity 0.8.2x, Foundry, OpenZeppelin, v4-core, v4-periphery |
| Automation | `sentinel-verdict` CRE workflow (EVM log trigger, reads, HTTP, consensus, write report); optional `band-publisher` (cron) | CRE TypeScript SDK, Bun, CRE CLI |
| Orchestration | Watcher, replay harness, Arkiv writer, Swarm uploader, incident data pipeline | TypeScript, viem, Node 22 or Bun |
| Data | Arkiv entities; Swarm evidence bundles; cached incident JSON in the repo | `@arkiv-network/sdk`, Bee API or gateway |
| Frontend | Replay Theater, Live Monitor, "Was I wronged?" lookup, Incident Explorer, Reserve dashboard | Next.js 15, Tailwind, viem |
| Testing | Unit, fuzz, invariant, fork tests; CRE workflow tests | Foundry, `bun test`, Anvil |
| Infra | Archive RPC (mainnet), Sepolia RPC, Etherscan API V2, hosting | Alchemy/Ankr/Infura, Vercel, GitHub Actions |

Pin versions at install time and record them in the README.

### 7.2 Repo layout

```
redress/
├─ README.md                 # sponsor sections with file+line pointers
├─ PRD.md
├─ FEEDBACK.md               # Uniswap requirement
├─ LICENSE                   # MIT
├─ arkiv/                    # Arkiv requirement files
│  ├─ schema.md  friction.md  reach.md  why-arkiv.md  how-you-use-arkiv.md  swarm.md
├─ contracts/
│  ├─ src/{RedressVault.sol, VerdictMath.sol, OperatorBond.sol, RecoveryLedger.sol}
│  ├─ src/hooks/BandOracleHook.sol
│  ├─ test/{unit,fuzz,invariant,fork}/
│  └─ script/{DeployVault.s.sol, DeployHook.s.sol, MineHookAddress.s.sol}
├─ cre/
│  ├─ project.yaml           # targets: fork, sepolia
│  └─ sentinel-verdict/{main.ts, sources/, verdict.ts, config.*.json}
├─ replay/
│  ├─ data/incident-2026-03-10.json   # cached on-chain data
│  ├─ fetch-incident.ts  fork-up.sh  replay.ts  scorecard.ts
├─ backend/{watcher.ts, arkiv.ts, swarm.ts, api.ts}
├─ web/                      # Next.js app
└─ .github/workflows/ci.yml
```

### 7.3 Contract interfaces (sketch)

```solidity
struct Verdict {
    bytes32 liquidationTx;    // tx hash of the LiquidationCall
    uint32  logIndex;
    uint64  blockNumber;
    address user;             // recipient
    address collateralAsset;
    address debtAsset;
    uint256 debtToCover;      // X
    uint256 collateralSeized; // C
    uint256 bandLowE18;       // p_c^L (numeraire per collateral unit)
    uint256 bandHighE18;      // p_c^H
    uint256 debtPriceHighE18; // p_d^H
    uint8   verdict;          // 0 VALID, 1 WRONGFUL, 2 EXCESS, 3 AMBIGUOUS, 4 INCONCLUSIVE
    uint8   sourceCount;
    uint256 redress;          // computed off-chain, re-derived on-chain
    bytes32 evidenceHash;     // keccak256 of the Swarm bundle
}

interface IRedressVault {
    function onReport(bytes calldata metadata, bytes calldata report) external; // forwarder only
    function fund(uint256 amount) external;
    function receiveRecovery(bytes32 liquidationTx, uint256 amount) external;
    event Attested(bytes32 indexed liquidationTx, uint32 logIndex, address indexed user, uint8 verdict, uint256 redress, bytes32 evidenceHash);
    event Paid(bytes32 indexed liquidationTx, address indexed user, address asset, uint256 amount, uint8 source /*bond|reserve|treasury*/);
}
```

The vault re-derives `redress` from the report's fields with `VerdictMath` and reverts if the CRE-supplied value differs or exceeds the per-event cap. This keeps arithmetic deterministic and auditable on-chain.

### 7.4 CRE workflow: `sentinel-verdict`

**Trigger.** EVM log trigger on Aave `LiquidationCall` for the Core and Prime Pools (limit: 5 addresses per workflow). topic0 `0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286` (computed locally from the event signature `[DERIVED]`). In replay, run with `--evm-tx-hash` and `--evm-event-index` `[PRIMARY: CRE docs]`.

**Steps**
1. Decode the event.
2. One Multicall3 `aggregate3` read at block `B-1`: user balances (aToken, debt token), E-Mode id and category data, reserve LT.
3. One Multicall3 read at block `B`: `AaveOracle.getAssetPrice(c, d)`, `stEthPerToken`, Chainlink feed round, Uniswap `observe`.
4. Two HTTP calls to off-chain aggregators, each with median consensus across DON nodes.
5. Build the band, run gate and verdict from `verdict.ts` (the same pure function the unit tests use).
6. Encode the report (< 1 KB) and write it to `RedressVault` (`--broadcast` in simulation).
7. Emit structured logs consumed by the backend (evidence bundle, Arkiv write).

**Quota budget** (limits as reported by a community CRE skill guide `[REPORTED]`; confirm in CRE docs `[VERIFY]`):

| Quota | Limit | Our use per execution |
|---|---|---|
| HTTP calls | 5 | 2 |
| EVM reads | 10 | 2 to 3 (Multicall3 batches the rest) |
| EVM write report size | 1 KB | ~300 to 400 bytes |
| Concurrent capability calls | 3 | respected |
| Log triggers | 5 per workflow | 2 pools |

**Deployment caveat.** Deploying to the live DON requires Early Access approval `[REPORTED]`; simulation is unrestricted and is all the Chainlink CRE prize requires `[PRIMARY: ETHGlobal page]`. For "live" mode the backend watches the chain and invokes the workflow in simulation per event (a pattern already used by other CRE projects), and the production path is DON deployment.

**Targets in `project.yaml`:** `fork` (reads and writes on the local mainnet fork) and `sepolia` (reads mainnet history, writes the vault on Sepolia).

### 7.5 Uniswap integration tiers

| Tier | What | Priority | Judge-visible evidence |
|---|---|---|---|
| **U1** | Uniswap v3 wstETH/WETH TWAP as an independent source in the verdict (on-chain `observe`) | Must | `cre/sentinel-verdict/sources/uniswapV3.ts`, replay scorecard |
| **U3** | New **`BandOracleHook`** for Uniswap v4: records observations and exposes `getBand(key, window) → (twapTick, minTick, maxTick, n)` so v4 markets get a native, manipulation-resistant price band without an external oracle | Should (cut line: ship U1 plus U2 if time slips) | `contracts/src/hooks/BandOracleHook.sol`, tests, Sepolia deployment |
| **U2** | Vault can settle reserve → payout asset through the Universal Router (for example a USDC reserve paying WETH) | Could | `RedressVault._swapToPayoutAsset`, fork test |

Hook notes: permission flags `afterInitialize` and `beforeSwap` (record pre-swap tick, like the geomean-style oracle hooks); hook address mined with CREATE2 so the low bits encode the flags; base on `BaseHook` from v4-periphery. Use the official Uniswap deployments page for PoolManager and Universal Router addresses. Note that Universal Router 2.1.2 release notes say some testnet v4 addresses previously had no onchain activity, so confirm activity on the explorer before use `[PRIMARY]`. Sepolia Universal Router listed there: `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3` `[VERIFY]`.

### 7.6 Arkiv data model

Built with `@arkiv-network/sdk`: `createEntity({ payload, contentType, attributes, expiresIn })`, queries through `buildQuery().where(eq(...))`; string attributes support only equality, numeric attributes support range filters `[PRIMARY: Arkiv docs]`. Use the testnet details on the Mumbai Arkiv prize page (chain ID 7794095, RPC and explorer listed there) and confirm the SDK chain config at install time `[VERIFY]`.

| Entity `type` | Key attributes (string unless marked `num`) | Payload | Expiry |
|---|---|---|---|
| `verdict` | `protocol`, `chainId`(num), `block`(num), `txHash`, `logIndex`(num), `user`, `verdict`, `redressMilliEth`(num), `deviationBps`(num), `srcCount`(num), `incidentId`, `evidenceBzz`, `vaultTx` | Full verdict JSON | 365 days |
| `incident` | `incidentId`, `protocol`, `startBlock`(num), `endBlock`(num), `victims`(num), `totalRedressMilliEth`(num), `status` | Incident summary | 365 days |
| `claim` | `claimId`, `user`, `kind` (`trueup`), `status`, `amountMilliEth`(num) | Claim JSON | Claim deadline (7 days): **expiry is the feature** |
| `recovery` | `liquidationTx`, `liquidator`, `status`, `amountMilliEth`(num) | Recovery JSON | 90 days |

Amounts in wei are stored in the payload as strings; numeric attributes use milli-ETH or basis points for range queries.

Owner: the Sentinel attestor wallet (only it can update status). The canonical truth stays on-chain in the vault events; Arkiv is the queryable index and evidence directory. At least one user-visible feature must *read* from Arkiv: the "Was I wronged?" lookup and the Incident Explorer both do.

Sample queries: see Appendix B.

### 7.7 Swarm evidence bundle (bonus)

Each verdict has a JSON bundle uploaded to Swarm: raw source responses with timestamps, Uniswap observations, position snapshot, formula steps, versions, and `keccak256(bundle)`. The vault stores `evidenceHash` on-chain, and the Arkiv `verdict` entity stores the `evidenceBzz` reference. The bundle is public data, so no encryption keys are ever placed in an entity (the Arkiv page warns encrypted references embed the key). Needs a postage batch from the Swarm/Arkiv booth or our own Bee node.

### 7.8 Frontend and API

| Page | Purpose |
|---|---|
| **Replay Theater** (hero) | Plays 10 March 2026 block by block: oracle vs independent band, each liquidation flagged, payouts landing, scorecard |
| **Live Monitor** | Tails real Aave Core and Prime liquidations; shows band, gate, and `VALID` verdicts (continuous negative control) |
| **Was I wronged?** | Enter an address; reads Arkiv; shows verdict, payout tx, evidence |
| **Incident Explorer** | SQL-like filters over Arkiv: incident, protocol, block range, redress size |
| **Reserve and coverage** | Reserve size, bond, and a stress calculator: "if the oracle were wrong by x%, how many accounts and how much redress" |

API (backend): `GET /verdicts`, `GET /incident/:id`, `POST /replay/start` (local only), SSE stream for the theater.

---

## 8. The replay: "10 March 2026, re-run"

### 8.1 Data acquisition (first task, ~2 hours)

`replay/fetch-incident.ts` builds `replay/data/incident-2026-03-10.json` and commits it, so nobody depends on a live API during judging.

1. Resolve the Core Pool via `PoolAddressesProvider` (`0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` `[PRIMARY, multiple sources]`) and the Prime Pool `[VERIFY]`.
2. Resolve the oracle at the target block with `getPriceOracle()`. Registries list two different AaveOracle addresses across versions (`0x54586bE62E3c3580375aE3723C145253060Ca0C2` and `0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7`), so never hard-code it `[VERIFY]`.
3. Find the block range from timestamps. The off-chain engine submitted the update at about 11:46 UTC on 10 Mar and the execution followed one block later `[REPORTED]`.
4. Pull every `LiquidationCall` log for `collateralAsset = wstETH` (`0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`) and `debtAsset = WETH` (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) via the Etherscan API V2 `logs` endpoint, from the execution block until the realignment block.
5. Expected result: **34 distinct users, ~10,938 wstETH in total**. Any other count is a bug or a data-source difference to explain in the README.
6. Store for each liquidation: tx hash, block, log index, user, `X`, `C`, liquidator, builder (block coinbase), and the Aave oracle price at the block.

Known transaction hashes to confirm `[REPORTED]`:

| Item | Hash |
|---|---|
| Parameter update submission | `0xfbafeaa8c58dd6d79f88cdf5604bd25760964bc8fc0e834fe381bb1d96d3db95` |
| Execution (the glitch trigger) | `0x32c64151469cf2202cbc9581139c6de7b34dae2012eba9daf49311265dfe5a1e` (appears in three independent sources) |
| Borrow cap cut | starts `0x34f568b2…` (complete from Etherscan) |
| Two of the five largest liquidations | start `0x9064b507f…` and `0x7872defde…` (complete from Etherscan) |

### 8.2 Two replay environments

| Profile | Reads | Writes | Purpose |
|---|---|---|---|
| **Fork-Faithful** (local) | Anvil fork of mainnet just before the execution block | Real Aave contracts re-execute the original transactions under impersonation; vault deployed on the fork with real WETH funded by impersonating a whale | Exact financials, real bytecode, real liquidations. Used for the video and live demo |
| **Public-Mirror** (Sepolia) | Mainnet archive RPC (historical) | `RedressVault` on Sepolia with test WETH; the **same 34 victim addresses** are paid in test tokens at 1:1 amounts | Public, clickable, verifiable on Sepolia Etherscan; counts as the deployed project |

### 8.3 Replay procedure

```
make fork-up        # anvil --fork-url $MAINNET_RPC --fork-block-number <executionBlock - 1>
make deploy-fork    # vault, bond, ledger; fund reserve; register adapter->operator (demo)
make replay         # re-executes the original txs in order (impersonation), then for each LiquidationCall:
                    #   cre workflow simulate sentinel-verdict --target fork --broadcast \
                    #     --non-interactive --trigger-index 0 --evm-tx-hash <tx> --evm-event-index <i>
make scorecard      # compares results with ground truth and writes web/public/replay.json
make mirror         # same verdicts, written to Sepolia + Arkiv + Swarm
```

If re-executing every original transaction proves unstable, fall back to *log replay*: keep the fork at the post-incident block, and feed only the recorded events and historical reads to the workflow. This loses the "live glitch" feel but keeps every number intact `[DECISION]`.

### 8.4 Scorecard (what the judges see)

| Metric | Ground truth / baseline | Target |
|---|---|---|
| Classification of the 34 incident accounts | All wrongful (they were healthy at true prices) | 34 / 34 `WRONGFUL` |
| Total redress | DAO refund 512.19 ETH headline; ARFC table components sum to 512.48 ETH | within ±2% of the DAO figure; the aggregate arithmetic in 6.6 already lands at −0.24% to −0.30% |
| Per-user accounting | None published by the DAO | 34 per-user rows with evidence links |
| Detection latency | LlamaRisk detected within minutes; the ARFC came the next day | ≤ 2 blocks after the first `LiquidationCall` |
| Time to payout | ~3 weeks (10 Mar → ~1 Apr) | Same transaction as the attestation, after `N=2` confirmations |
| False positives on normal liquidations | n/a | **0** across the negative-control set |
| Reserve consumed | n/a | ≈ 3.8% of affected collateral value `[DERIVED]` |
| Recovery tracking | 141.6 ETH + 41.62 WETH recovered manually | Recovery claims opened automatically against liquidator and builder addresses |

### 8.5 Before and after timeline

| Step | What actually happened | With Redress |
|---|---|---|
| Glitch executes | Cap falls ~2.85% below market | Same (we don't touch the oracle) |
| First liquidation | Bots seize collateral | Gate fires (2.84% gap against τ = 0.75%) |
| +1 to 2 blocks | Nobody has acted yet | Verdict `WRONGFUL`, evidence bundle on Swarm, Arkiv entry |
| +2 confirmations | Liquidations continue until containment | Payout to victim from bond/reserve |
| Minutes | Detection by a monitor | Already done and public |
| Next day | ARFC drafted | Per-user table already published |
| ~3 weeks | Refunds distributed, no per-user accounting | Closed weeks earlier; recovery claims tracked |

### 8.6 Negative controls and stress tests (specificity matters)

1. **Calm-day control:** at least 200 real Aave liquidations from a quiet period, expecting all `VALID`, zero payouts.
2. **Volatility control:** a real market-driven cascade (for example the August 2024 volatility spike mentioned in governance discussion `[REPORTED]`), expecting `VALID` because the independent band falls with the market.
3. **Over-pricing glitch:** synthetic: oracle too high, expecting no payout and an `OVERPRICED` anomaly.
4. **Source outage:** drop two sources, expecting `INCONCLUSIVE` and no payout, then automatic re-evaluation.
5. **Single-source manipulation:** push one source 5% off, expecting outlier rejection and an unchanged verdict.
6. **Boundary case:** a position exactly at the threshold, expecting `AMBIGUOUS`, paying only the provable excess.
7. **Reserve exhaustion:** feed more redress than the epoch cap, expecting payouts to stop at the cap and the rest queued.

### 8.7 Live mode (real-life use)

- The backend tails new `LiquidationCall` events on Core and Prime and runs the gate. The Live Monitor shows every liquidation with its band and verdict; on a normal day all are `VALID`, which is a continuous public negative control.
- A glitch can be demonstrated live on the fork by replaying the real parameter-update transaction under impersonation.
- Real-money mainnet payouts are out of scope for the hackathon. The path to production is: deploy the workflow on the CRE network (Early Access), fund a mainnet vault, and let a protocol or DAO whitelist it `[REPORTED]`.

### 8.8 Honest limitations to state in the README

- Redress restores net worth; it cannot restore a borrower's *position* (their leverage and yield strategy).
- The MVP covers single-collateral, single-debt positions (the incident class: wstETH collateral, WETH debt). Multi-asset positions are Phase 2 (`UiPoolDataProvider.getUserReservesData`).
- CRE runs in simulation for the demo. DON deployment needs Early Access.
- The reserve is seeded for the demo; a sustainable funding model is described, not proven.
- Our independent sources could themselves be wrong in a systemic way (all feeds failing together). The band logic and `INCONCLUSIVE` path reduce but don't eliminate this.

---

## 9. Sponsor strategy and compliance (leaderboard section)

### 9.1 Pick math

ETHGlobal allows up to **three partner prizes per project**, and a partner with several tracks counts as one pick. Arkiv's page states its prizes count as one partner prize. Confirm the Mumbai-specific rule on the submission form `[VERIFY]`.

| Sponsor | Track | Prize | Our fit |
|---|---|---|---|
| Uniswap Foundation | Build with Uniswap (open) | $10,000: 1st $4,000, 2nd $3,000, 3rd $2,000, 4th $1,000 | U1 + U3 (+U2) |
| Chainlink | Best workflow with CRE | $1,500 (single prize) | Core engine |
| Chainlink | CCIP 2.0 (optional) | $3,500: up to 2 teams at $1,750 | Cross-chain payout stretch |
| Arkiv | Build on Arkiv (from scratch) | $4,000: 1st $3,000, 2nd $1,000 | Ledger and lookup |
| Arkiv | Arkiv + Swarm bonus (from scratch) | $500, on top of a track prize | Evidence bundles |
| ETHGlobal | Finalist (top 10 teams) | Team of 3: 1,000 USDC + 500 USDC travel per person = 3,000 + 1,500; plus $10,000 AWS credits and Plus discount | Hero demo |

Best case if everything lands: Uniswap $4,000 + CRE $1,500 + Arkiv $3,000 + Swarm $500 = **$9,000**, plus CCIP $1,750 = $10,750, plus finalist $4,500. These are ceilings, not forecasts. Uniswap has four paid places, which makes it the most reliable of the three.

### 9.2 Uniswap compliance checklist

Requirements `[PRIMARY]`: public GitHub repo with open-source code, a `FEEDBACK.md`, and a completed submission to the Uniswap Developer Feedback Form (https://developers.uniswap.org/hackathon-feedback) including the link to `FEEDBACK.md`. Submissions without it are audited before winners are finalized. The README must point to the relevant contracts and lines of code.

- [ ] Repo public, MIT license, steady commit history.
- [ ] `FEEDBACK.md`: what worked, what blocked us, missing docs, one highest-impact fix. Write it as we go, not at the end.
- [ ] Feedback form submitted with the `FEEDBACK.md` link.
- [ ] README section "Uniswap integration" listing exact files and line ranges for U1, U3, U2.
- [ ] `BandOracleHook` deployed and verified, pool initialised, swaps executed so the band has data, tests included.
- [ ] Demo shows the Uniswap value in the verdict (S2 line in the evidence panel).

### 9.3 Chainlink compliance checklist

CRE track `[PRIMARY]`: build, simulate, or deploy a CRE workflow used as an orchestration layer; integrate at least one blockchain with an external API, system, data source, LLM, or agent; show a successful simulation through the CRE CLI or a live deployment; be meaningfully used in the project. Simulation is enough.

- [ ] Workflow integrates two chains (mainnet read, Sepolia write) and external HTTP sources.
- [ ] Simulation transcript with `--broadcast` and the resulting transaction hashes in the README.
- [ ] README section "Chainlink usage" listing workflow files; explain what breaks without CRE (no trust-minimised multi-source verdict, no consensus, no authorised onchain report).
- [ ] Chainlink Data Feed(s) used as a source where a feed exists.

CCIP stretch `[PRIMARY]`: the CCIP prize requires using CCIP in contracts to make a state change; a front end reading data does not count. It is unclear whether the CRE prize depends on this ("core prizes"), so **ask the Chainlink mentors early** `[VERIFY]`. Proposed use: one reserve hub pays victims of the same incident class on other chains where the protocol is deployed (CCIP programmable token transfer carrying the verdict ID). Build only after Gate G3 (Section 10.3). Timebox: 6 to 8 hours; drop if it threatens the core.

### 9.4 Arkiv + Swarm compliance checklist

Requirements `[PRIMARY: Arkiv prize page]`:

- [ ] Built from scratch at the event, following ETHGlobal rules; public repo with an open-source license; say how AI was used.
- [ ] Writes to Arkiv's current testnet with `@arkiv-network/sdk` or JSON-RPC, and at least one user-visible feature reads from it (our lookup and explorer).
- [ ] README: the wallet address(es) that wrote entities, and one query judges can run.
- [ ] `/arkiv/schema.md`: entities, queried fields, owners, expiry.
- [ ] `/arkiv/friction.md`: honest feedback (25% of the score).
- [ ] `/arkiv/reach.md`: who uses it and whether it ships after Mumbai.
- [ ] `/arkiv/why-arkiv.md`: what users would lose with Postgres.
- [ ] `/arkiv/how-you-use-arkiv.md`: filters, ownership, and expiry fit the app; what we kept off Arkiv and why.
- [ ] Each file answers its questions with links, numbers, or runnable queries.
- [ ] Not counted: SDK installed but unused, or Arkiv as a log nobody reads.
- [ ] One Arkiv track prize per team; the Swarm bonus can stack.

Swarm bonus: `/arkiv/swarm.md` with what lives on Swarm versus Arkiv, which field holds the reference, one entity key and its Swarm link, the postage batch ID and wallet, upload and read files, steps to run them, the video timestamp, and what got in the way. Never store an encrypted reference in a public entity.

### 9.5 Finalist play

Finalists are the top 10 teams. The hero replay is built for this: a real incident, a verifiable scorecard, and a three-minute story. Practise the live demo twice with the recorded fallback ready.

### 9.6 Why not other sponsors, and when to swap

| Sponsor | Reason not chosen | Swap if |
|---|---|---|
| World | Payout path must have no human in it; Agent Pass and IDKit are human-verification tools | We add an optional human appeal path |
| ENS | ENSv2 would be cosmetic here (names for liquidators or operators) | We find a real need for named, expiring registrations |
| Arc | Every Arc prize requires Arc Studio as the starting point and settlement on Arc; our core lives on Ethereum | We pivot the vault to Arc |
| 1inch Aqua | No fit | None |
| Ethereum Foundation (Anon-RPC) | Plausible add-on: private reads for the "Was I wronged?" lookup, since RPC providers otherwise learn which addresses people check. Counts as a pick, and EF allows one prize per project | Arkiv work slips and we want a lighter third pick |
| 0G, Hedera, Whitechain, Definitive | No natural fit; Definitive is Continuity-only | None |

### 9.7 Judging tactics

- Open every sponsor section with "where to look": file, line, and the demo timestamp.
- Show the Uniswap and Chainlink contribution *inside the verdict panel*, so judges see each source as a named line in the evidence.
- Keep a recorded replay as backup for every live step.
- Prepare one slide per sponsor with the rule text and our evidence side by side.

---

## 10. Scope, plan, roles

### 10.1 MoSCoW

| Priority | Item |
|---|---|
| **Must** | Verdict engine (`verdict.ts` plus `VerdictMath.sol`) with unit and fuzz tests; incident dataset; CRE workflow with log trigger and multi-source band; vault with payout and idempotency; replay on fork with scorecard; Sepolia deployment; Arkiv writes and the "Was I wronged?" read feature; U1; README, FEEDBACK.md, Arkiv files, demo video |
| **Should** | `BandOracleHook` (U3); Swarm evidence bundles; Replay Theater polish; Live Monitor; negative-control suite; OperatorBond; RecoveryLedger; reserve stress calculator |
| **Could** | Uniswap swap settlement (U2); true-up payouts; CCIP cross-chain payout; Anon-RPC for lookups |
| **Won't (this event)** | Mainnet vault, multi-asset positions, Guard mode, protocol integration |

### 10.2 Roles (team of 3)

| Person | Owns | Backup for |
|---|---|---|
| **A: Contracts** | Vault, VerdictMath, bond, ledger, hook, Foundry tests, deployments | CRE config |
| **B: Automation and data** | Incident pipeline, CRE workflow, replay harness, scorecard, negative controls | Contract tests |
| **C: Product and docs** | Next.js app, Arkiv and Swarm, README and sponsor files, video, pitch | Data scripts |

### 10.3 Phases and gates

Hours are relative to kickoff of the build. Confirm the submission deadline on the event page `[VERIFY]` and freeze features at least 6 hours before it.

| Phase | Hours | Deliverables | Gate |
|---|---|---|---|
| 0. Setup | 0 to 4 | Repo, CI, keys, archive RPC, Etherscan key, incident JSON committed, `FEEDBACK.md` started | **G0:** 34 liquidations in `incident-2026-03-10.json`; CRE hello-world reads mainnet |
| 1. Engine | 4 to 12 | `verdict.ts` plus `VerdictMath.sol` agree on test vectors; offline replay classifies 34 / 34; vault skeleton | **G1:** scorecard numbers reproduced offline |
| 2. Pipeline | 12 to 22 | CRE workflow end to end on the fork; payouts land; idempotency, caps | **G2:** `make replay` runs in one command |
| 3. Public | 22 to 30 | Sepolia deployment; Arkiv writes and reads; Swarm bundles; Etherscan-verified contracts | **G3:** public lookup works end to end |
| 4. Depth | 30 to 38 | Hook (U3); negative controls; Live Monitor; (CCIP only if G3 passed and time remains) | **G4:** all negative controls pass |
| 5. Ship | 38 to 46 | Docs, sponsor files, video, rehearsal, submission | **G5:** submission package complete (Section 13) |

### 10.4 Cut lines (decide by hour 30)

1. Drop CCIP.
2. Drop U2.
3. Simplify U3 to a documented hook with tests but no pool UI.
4. Fall back from fork replay to log replay.
5. Drop Swarm if no postage batch by hour 24.

Never cut: the verdict engine tests, the replay scorecard, negative controls, and the three sponsor documentation sets.

---

## 11. Testing and quality bar

| Layer | What we test | Tool | Bar |
|---|---|---|---|
| `VerdictMath` (Solidity) vs `verdict.ts` | Same inputs, same outputs, bit for bit, on 10,000+ random vectors | Foundry fuzz plus a shared JSON test-vector file | 100% agreement |
| Invariants | Total paid never exceeds funded plus recovered; one payout per `(tx, logIndex)`; payout never exceeds `C · p_c^L`; epoch cap holds; no payout on `VALID`, `OVERPRICED`, `INCONCLUSIVE` | Foundry invariant tests | All hold over 256 runs × 500 calls |
| Band logic | Outlier rejection, `minSources`, staleness, widening margin | Unit tests | Edge cases listed in Section 8.6 |
| Aave state rebuild | `A`, `D`, LT, E-Mode category match Aave's own `getUserAccountData` at `B-1` | Fork tests on 5 incident users | Exact match |
| CRE workflow | Handler logic with mocked capabilities; real simulation on fork | `bun test`, `cre workflow simulate` | Both pass |
| Replay | 34 / 34 classified, total within ±2% of the DAO figure | `make scorecard` | Matches Section 8.4 |
| Negative controls | 0 false positives across 200+ real liquidations | Replay harness | 0 payouts |
| Frontend | "Was I wronged?" returns correct data for incident users and a clean "no record" for others | Manual plus Playwright smoke | Pass |

CI runs Foundry tests, `bun test`, lint, and a script that fails the build if any `[VERIFY]` marker remains in `README.md`.

## 12. Security and ethics

- **Honest claims only.** README and video say "economic restitution", never "reversal". They say "simulated CRE" where it is simulated.
- **No accusations.** The demo names the oracle operator generically ("demo operator"). Facts about Chaos Labs, BGD, or others are quoted from the public post-mortem only if needed, never characterised.
- **Keys.** Attestor and deployer keys live in env vars and CI secrets, never in the repo. Testnet only. The README says so.
- **Mainnet disclaimer.** No mainnet funds are handled by this project.
- **Data licence.** Incident data comes from public chain data and public governance posts; credit them in the README.
- **AI disclosure.** Both ETHGlobal and Arkiv require saying how AI was used. Add an "AI usage" section to the README (what was generated, what was reviewed, what was written by hand).
- **Responsible framing of the reserve.** The vault is a mechanism design demo, not an insurance product.

## 13. Submission package (Gate G5)

| Item | Needed by | Owner |
|---|---|---|
| Public GitHub repo, MIT licence, readable commit history | all sponsors | C |
| README with: problem, how it works, architecture diagram, setup, limitations, AI usage, CROPS-style honesty on trust assumptions | all | C |
| Sponsor sections in README, each with file and line pointers and a demo timestamp | all | C |
| `FEEDBACK.md` plus the Uniswap feedback form submitted with its link | Uniswap | C |
| `PRD.md` kept in repo as design record | judges | C |
| Contract addresses: Sepolia vault, bond, ledger, hook; verified on Etherscan | Uniswap, Chainlink, ETHGlobal | A |
| CRE simulation transcript with `--broadcast` tx hashes in README | Chainlink | B |
| `/arkiv/*.md` files (schema, friction, reach, why-arkiv, how-you-use-arkiv, swarm) | Arkiv | C |
| Arkiv writer wallet address(es) and one runnable query in README | Arkiv | C |
| Swarm postage batch ID, bundle link, entity key | Arkiv + Swarm | C |
| Live demo link (hosted frontend) | ETHGlobal, ENS-style requirements elsewhere | C |
| Demo video, under 3 minutes (Arkiv/0G-style limit; use it as our cap) | ETHGlobal | C |
| Team names plus Telegram and X handles | ETHGlobal | all |
| Backup recording of every live demo step | internal | B |
| Mentor confirmations: CRE and CCIP eligibility; three-pick rule; Arkiv + Swarm stacking | internal | B / C |

## 14. Pitch and demo script

### 14.1 One-line pitch
"When an oracle gets it wrong, Redress proves it and pays the victims in blocks, not weeks."

### 14.2 Story arc (3 minutes)

| Time | Beat | What is on screen |
|---|---|---|
| 0:00 | Hook: "On 10 March, a configuration mismatch priced wstETH about 2.85% too low. Thirty-four healthy accounts were liquidated. The fix took three weeks and a governance vote." | Timeline graphic, real numbers |
| 0:25 | Insight: "Finality means you can't undo a liquidation. But you can restore what was lost, automatically, from evidence anyone can check." | Redress logo, one-line diagram |
| 0:45 | Engine: independent band from Lido, Uniswap TWAP, two off-chain sources via CRE consensus; interval verdict; provable-floor payout | Evidence panel with four named sources |
| 1:10 | Replay: press play on 10 March; bands, red oracle line, 34 liquidations flagging, payouts landing | Replay Theater |
| 1:50 | Scorecard: 34/34, total vs DAO figure, ~3 weeks vs ~2 blocks, 0 false positives | Scorecard slide |
| 2:10 | Public proof: "Was I wronged?" lookup, Arkiv query, Swarm evidence bundle, Sepolia transaction | Browser demo |
| 2:30 | Live mode: calm-day monitor showing `VALID`, then one glitch on the fork | Live Monitor |
| 2:45 | Close: honest limits, roadmap to Guard and Native modes, ask: "Let protocols whitelist a vault like this." | Roadmap |

### 14.3 Anticipated questions

| Question | Answer |
|---|---|
| Why not just pause liquidations on anomalies? | That needs protocol change and Chaos Labs argued it can conflict with CAPO's protective role. Redress works beside the protocol and never touches its oracle. |
| Who funds the reserve? | Demo: seeded. Production options: operator bonds, a slice of liquidation protocol fees or recaptured oracle value, and recoveries from liquidators and builders. Documented, not claimed as proven. |
| Can someone game it? | Median of independent sources, outlier rejection, provable-floor payout, caps, and a gate. The attacker would need to move several independent sources at once. |
| Isn't this just insurance? | It pays on objective evidence with no claim process, no discretion, and a public ledger. |
| Why the Chainlink workflow instead of a keeper? | CRE gives multi-source reads, consensus, and an authorised onchain report in one workflow; without it we would have to trust a single server. |
| Is it live? | Testnet and fork, simulated workflow. The path to production is DON deployment under Early Access. |
| What if all your sources are wrong together? | Verdict becomes `INCONCLUSIVE` when sources disagree; a systemic failure of every source is a stated limitation. |

## 15. Risks and open questions

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| Incident data does not give exactly 34 users / 10,938 wstETH | Medium | High | Explain differences (Core vs Prime, window). Never tune the data to fit |
| Re-executing original txs on a fork is brittle | Medium | Medium | Log-replay fallback (Section 8.3) |
| CRE simulation cannot reach the needed archive state | Medium | High | Run reads through our own RPC target; precompute and cache sources only if unavoidable, and disclose it |
| Off-chain price APIs lack history for 10 March | High | Medium | Use APIs with historical endpoints or cached snapshots committed to the repo; the Uniswap TWAP and Lido rate are fully on-chain |
| Hook address mining or v4 testnet quirks cost time | Medium | Medium | Cut line 3 (Section 10.4); confirm deployments have activity |
| Arkiv or Swarm access delays | Medium | Medium | Get keys and a postage batch in hour 0; cut Swarm if blocked |
| CCIP does not count towards the CRE prize or is out of scope | Low | Low | Treat CCIP as optional; ask mentors |
| Judges see it as "just a dashboard" | Medium | High | Lead with payouts and the vault; show the contract tests and the negative controls |
| Another team builds a similar idea | Low | Medium | Our edge is the real-incident replay with a scorecard and the provable-floor design |

Open questions to settle in hour 0: confirm the Mumbai three-pick rule and deadline; confirm that CRE `--broadcast` works against a local fork target; confirm the E-Mode bonus; resolve the Prime Pool address; choose the two off-chain price sources and check their historical coverage.

## 16. Success metrics

| Metric | Target |
|---|---|
| Incident accounts classified `WRONGFUL` | 34 / 34 |
| Total redress vs DAO figure | within ±2% |
| False positives on controls | 0 |
| Detection to payout | ≤ 2 blocks plus `N` confirmations |
| Test suite | ≥ 95% line coverage on `VerdictMath`; all invariants pass |
| Public artefacts | 1 hosted app, ≥ 34 Arkiv verdict entities, ≥ 1 Swarm bundle, verified contracts |
| Sponsor evidence | Each sponsor section answered with file, line, and timestamp |
| Competitive | Finalist; placing in Uniswap's top four; Arkiv and CRE prizes |

## 17. Etherscan verification plan (do this first)

Everything tagged `[VERIFY]` is checked in hour 0 with `redress-scripts/verify-onchain.mjs` (shipped with this PRD; syntax-checked, and its five function selectors confirmed against the signatures; **not yet run against a live node**). It needs an Etherscan API key (V2) and an archive RPC.

| `[VERIFY]` item | How |
|---|---|
| Core Pool and Oracle addresses | Script reads `getPool()` and `getPriceOracle()` from the PoolAddressesProvider |
| Prime Pool address | Aave address book (script has a TODO) |
| 34 users, ~10,938 wstETH | Script pulls `LiquidationCall` logs for wstETH/WETH and counts them |
| Submission and execution tx hashes | Script confirms both receipts and prints block numbers |
| Borrow-cap and top-five liquidation tx hashes | Complete the truncated hashes from Etherscan; add to `incident.json` |
| E-Mode liquidation bonus (assumed 1%) | Read the E-Mode category config at the incident block |
| Deepest Uniswap v3 wstETH/WETH pool | Script lists 0.01%, 0.05%, 0.3% pools with liquidity |
| `stEthPerToken` vs quoted 1.2288 | Script reads it (at the incident block, rerun with a block tag) |
| CRE forwarder and Receiver pattern | CRE docs and templates |
| Sepolia Universal Router and v4 PoolManager have activity | Explorer plus Uniswap deployments page |
| CRE quotas | CRE docs service-quota page |
| Arkiv testnet config in the SDK | Arkiv docs and the Mumbai prize page |

Pass condition: no `[VERIFY]` left in the README, and the script's output committed as `replay/data/verification-report.txt`.

---

## Appendix A: Worked example (one victim, illustrative)

Numbers below are constructed to be consistent with the incident rates; they are **not** one of the 34 real accounts. LT = 0.955 is an assumed E-Mode value (`[VERIFY]`).

| Quantity | Value |
|---|---|
| Collateral `A` | 300 wstETH |
| Debt `D` | 345.16 WETH |
| Oracle price `p_c^o` | 1.193957 → `HF` = 0.9910 (liquidatable) |
| Independent band (widened by 10 bps) | [1.22717, 1.23053] |
| `HF_worst`, `HF_best` | 1.0186, 1.0214 (healthy in the whole band) |
| Gate | 2.84% gap > τ = 0.75% → open |
| Verdict | `WRONGFUL` (since `HF_worst` ≥ 1.001) |
| Liquidation | `X` = 172.58 WETH (50% close factor), `C` = 145.99 wstETH (1% bonus at oracle price) |
| Redress floor | `C · p_c^L − X` = **6.575 WETH** |
| Redress at median price | 6.820 WETH (floor is 3.6% below, which is the price of being provable) |
| Redress as share of collateral value | ≈ 3.7%, in line with the incident-wide ≈ 3.8% |

## Appendix B: Sample Arkiv queries

```ts
import { eq, gt } from "@arkiv-network/sdk/query";
// All wrongful verdicts for one incident
await publicClient.buildQuery()
  .where([eq("type","verdict"), eq("incidentId","aave-2026-03-10"), eq("verdict","WRONGFUL")])
  .withAttributes(true).withPayload(true).fetch();
// Verdicts for one address
await publicClient.buildQuery()
  .where([eq("type","verdict"), eq("user", addr.toLowerCase())]).fetch();
// Large redresses (numeric attribute enables range filter), over 5 ETH
await publicClient.buildQuery()
  .where([eq("type","verdict"), gt("redressMilliEth", 5000)]).fetch();
```

Store addresses lowercase so equality filters match. Numeric attributes must be written as numbers, not strings, to allow range queries (Arkiv docs).

## Appendix C: Glossary

Collateral, debt, health factor, liquidation, bonus, close factor, oracle, CAPO, E-Mode, TWAP, hook, CRE, CCIP, Arkiv, Swarm, bond, reserve, band, gate, verdict, provable floor. See the earlier plain-language glossary in this conversation; add a copy to the README for beginners.

## Appendix D: Sources

- Aave governance: Chaos Labs post-mortem (10 Mar 2026); TokenLogic reimbursement ARFC (11 Mar 2026) and thread; LlamaRisk response.
- ETHGlobal Mumbai prize pages: Uniswap Foundation, Chainlink, Arkiv (+ Swarm), finalist prizes.
- Chainlink docs: CRE simulation, EVM log trigger; Chainlink SVR docs and analysis.
- Arkiv docs and SDK guides; Uniswap Universal Router 2.1.2 release notes.
- Secondary reporting (all `[REPORTED]`): Rekt, DEV Community thread (tx hashes), CoinDesk/The Block coverage, Cryptonomist (Vesu), Moonwell coverage, Interlay referendum.
