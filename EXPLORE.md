# Explore Redress

A guided way through the project, from a five-minute look to giving the demo. Pick the path that fits.

| You want to | Go to | Time |
|---|---|---|
| See it working | [1. See the product](#1-see-the-product) | 5 minutes |
| Check the claims yourself | [2. Verify it on-chain](#2-verify-it-on-chain) | 10 minutes |
| Understand the code | [3. Read the code](#3-read-the-code) | 30 minutes |
| Run the tests | [4. Run the tests](#4-run-the-tests) | 1 to 10 minutes |
| Watch a real liquidation go through | [5. Run one liquidation](#5-run-one-liquidation-yourself) | 10 minutes |
| Give the demo | [6. Give the demo](#6-give-the-demo) | 3 minutes |

Other documents: [`documentation.md`](documentation.md) explains every file, and [`run_commands.md`](run_commands.md) lists every command.

## Setup

Use **Git Bash**, from the `redress` folder.

```bash
bun install
(cd cre/sentinel-verdict && bun install)
export PATH="$HOME/.foundry/bin:$HOME/.cre/bin:$PATH"
```

Sections 1 to 4 use committed data, so they need no keys, except for the fork tests. Section 5 needs a filled-in `.env` and `cre login`.

---

## 1. See the product

```bash
bun backend/api.ts
```

Open http://localhost:3001, then go through the pages in this order.

**Overview.** The story and the headline numbers. Note the comparison table: the floor is what Redress pays, and it sits 7.594% below the DAO's figure on purpose.

**Replay.** Press **Play**. The black line is the Aave oracle and the grey boxes are the independent band. Watch the oracle fall below the band in the first block and stay there, while the cumulative redress climbs to 473.2955.

**Was I wronged?** Try these three inputs:

| Address | Expected |
|---|---|
| `0x4f962BB0EA0785c539f8ab52a17f1f873DDc355f` | Wrongly liquidated, 230.5330 ETH. The largest event |
| `0x3aaC936216A43D4195791819ECc4975ba8fb6C72` | The one `AMBIGUOUS` position, paid only its provable excess |
| `0x0000000000000000000000000000000000000001` | No record |

Each result says whether Arkiv or the local JSON file answered.

**Explorer.** Set the verdict to `AMBIGUOUS`, then try a minimum redress of 20 ETH. The line above the results says what served them.

**Reserve.** "Who paid" shows the waterfall on one event: 100 from the bond, 130.5330 from the reserve. Then use the stress calculator. Set the reserve to 500 and watch payouts queue.

**Live.** Recent real Aave liquidations and the seven negative controls. Control 5 shows **No**, and that is deliberate: see `docs/SECURITY.md`, finding 4.

---

## 2. Verify it on-chain

Don't take the README's word for it. Everything below is public.

**One liquidation, end to end:**

1. The original mainnet liquidation: [`0x9064b507…8a9c`](https://etherscan.io/tx/0x9064b507f16bd8b85fb5aea0185153b01fa23b3205f7153f986e5107ce988a9c).
2. The Redress payout on Sepolia: [`0xc7ca7d75…fdb0`](https://sepolia.etherscan.io/tx/0xc7ca7d754a1d35fe5648996103cf1b2fd2db0b4d35b3424e38a31309b724fdb0). Open **Logs** to see two `Paid` events, the bond first, and the `ClaimOpened` event.
3. The CRE run that produced it: [`docs/transcripts/sepolia.txt`](docs/transcripts/sepolia.txt). Find `REDRESS_RESULT`.

**The contracts,** with source on Etherscan:

- [`RedressVault`](https://sepolia.etherscan.io/address/0xaccfe6e8939d3143f7f70a550ebf29dcfc197609#code)
- [`OperatorBond`](https://sepolia.etherscan.io/address/0x934d3fae4d7393ef34a35246b28aab0b05cddea4#code)
- [`RecoveryLedger`](https://sepolia.etherscan.io/address/0x82339ee18be49be221bac62c4fb30e2f1d7a055d#code)
- [`BandOracleHook`](https://sepolia.etherscan.io/address/0xc555e1ca0a109a1f02d238455ff4feda7ba5d080#code)

**Read the totals.** On the vault's **Read Contract** tab, or with `cast` after loading `.env`:

| Read | Expected | Meaning |
|---|---|---|
| Vault `totalPaid` | 373295500496135010048 | From the reserve |
| Vault `totalPaidFromBond` | 100000000000000000000 | From the bond |
| Ledger `totalExpected` | 473295500496135010048 | The sum of both, so every payout has a claim |

**Arkiv.** Run the query in [`arkiv/schema.md`](arkiv/schema.md), or browse the [Rabdi explorer](https://rabdi.explorer.arkiv.network) for the writer `0xD19D988fAe15c6AF0CB18FD5D79bffa41F8c2683`.

---

## 3. Read the code

Read in this order. Each step builds on the one before.

| # | File | What to look for |
|---|---|---|
| 1 | [`docs/VERDICT_SPEC.md`](docs/VERDICT_SPEC.md) | The rules in plain terms, and why each decision was made |
| 2 | [`cre/sentinel-verdict/verdict.ts`](cre/sentinel-verdict/verdict.ts) | The engine. Pure functions with no chain access |
| 3 | [`contracts/src/VerdictMath.sol`](contracts/src/VerdictMath.sol) | The same logic in Solidity |
| 4 | [`cre/sentinel-verdict/handler.ts`](cre/sentinel-verdict/handler.ts) | Start at `onLiquidation` and follow the reads |
| 5 | [`contracts/src/RedressVault.sol`](contracts/src/RedressVault.sol) | `onReport`, then `_canPay` and `_pay` |
| 6 | [`contracts/src/OperatorBond.sol`](contracts/src/OperatorBond.sol), [`contracts/src/RecoveryLedger.sol`](contracts/src/RecoveryLedger.sol) | Who pays and who owes |
| 7 | [`contracts/src/hooks/BandOracleHook.sol`](contracts/src/hooks/BandOracleHook.sol) | Then [`docs/HOOK_DESIGN.md`](docs/HOOK_DESIGN.md) for its honest role |
| 8 | [`replay/mirror.ts`](replay/mirror.ts) | How each event is run and checked |
| 9 | [`backend/arkiv.ts`](backend/arkiv.ts), [`backend/api.ts`](backend/api.ts) | How reads reach the site |
| 10 | [`docs/SECURITY.md`](docs/SECURITY.md) | What can still go wrong |

For the data, open `replay/out/replay.json`. Its shape is defined in `docs/replay.schema.json`.

---

## 4. Run the tests

### Quick (under 1 minute)

```bash
bun test              # expect: 150 pass, 0 fail
bun run typecheck     # expect: no errors
```

### Solidity

```bash
cd contracts
forge test --no-match-contract Invariant   # under a minute, with 3 fork tests skipped
forge test                                 # everything, about 9 minutes
cd ..
```

If Forge reports a missing `vectors-random.bin`, run `bun run vectors:random`.

**To include the fork tests,** which read real mainnet state:

```bash
set -a; . <(tr -d '\r' < .env); set +a
(cd contracts && forge test)    # expect: 115 tests passed, 0 failed, 0 skipped
```

### Single tests worth watching

Run these from `contracts/`. Add `-vvv` to see detail.

| Test | What it proves |
|---|---|
| `forge test --match-test test_rejectsTypeScriptReportsWithOneWeiAdded` | The vault rejects a report that is off by one wei |
| `forge test --match-test test_acceptsEveryTypeScriptIncidentReport` | TypeScript and Solidity agree on all 47 events |
| `forge test --match-test test_waterfall_bondExhaustion_reserveCoversTheRest` | The reserve covers what the bond cannot |
| `forge test --match-test test_bond_standingWithdrawalLapses` | An operator cannot keep a ready exit |
| `forge test --match-test test_singleLargeSwapMovesLongWindowTwapOnlySlightly` | A large swap barely moves the hook's TWAP |
| `forge test --match-test test_duplicateReportReverts` | One event cannot pay twice |

### The results themselves

```bash
bun run replay          # the 47 verdicts, offline, under each config
bun run scorecard       # the comparison with the DAO figures
bun replay/controls.ts  # the seven negative controls: expect 6 PASS and 1 FAIL
```

`bun run scorecard` rewrites `replay/out/replay.json`. If `git status` shows a change afterwards, look at it before committing.

### Break it on purpose

The best way to trust the tests is to watch them fail. Try one of these, then undo it with `git checkout <file>`:

| Change | Run | Expected |
|---|---|---|
| In `cre/sentinel-verdict/verdict.ts`, change `cfg.epsOutBps * m` to `cfg.epsOutBps * m * 100n`, so outliers survive | `bun test cre/sentinel-verdict` | 8 tests fail |
| In `contracts/src/RedressVault.sol`, delete the `ledger.openClaim(...)` line in `_pay` | `forge test --match-contract AccountabilityTest` | 7 tests fail |
| In `contracts/src/OperatorBond.sol`, delete the line that reverts with `WithdrawalExpired` | The same | 1 test fails: `test_bond_standingWithdrawalLapses` |

---

## 5. Run one liquidation yourself

This runs the real CRE workflow on a local fork. It touches no public network.

**You need:** `MAINNET_RPC` in `.env`, and `cre login`.

```bash
# terminal 1: the fork
bun run fork:up

# terminal 2: off-chain prices
bun run snapshot:serve

# terminal 3: a vault, then one event
bun run fork:deploy
bun replay/mirror.ts fork --limit 1
```

Expect a line ending in the vault transaction:

```text
1/47 WRONGFUL 230533099950029831035 vault tx 0x…
```

Then open `docs/transcripts/fork.txt` to see the simulator's output. Stop terminals 1 and 2 when you finish.

`fork:deploy` deletes the previous fork results, and the fork run overwrites the committed transcript. Run `git checkout replay/out/mirror-fork.json docs/transcripts/fork.txt` to restore them.

The fork vault has no bond, so this pays from the reserve only. To see the bond waterfall, use the Sepolia links in section 2.

---

## 6. Give the demo

### Prepare

1. Add `ARKIV_ACCESS_KEY` to `.env`, so the lookup keeps reading from Arkiv.
2. Run `bun backend/watcher.ts` for fresh live data.
3. Run `bun backend/api.ts`.
4. Open these in tabs: the site, the Sepolia payout from section 2, and the vault's page.
5. Rehearse once, and record it as your backup.

### Three-minute script

| Time | Say | Show |
|---|---|---|
| 0:00 | "On 10 March 2026 a misconfigured oracle undervalued wstETH on Aave. Healthy positions were liquidated, and the repair was a manual DAO process." | Overview |
| 0:25 | "You can't undo a liquidation. But you can restore what was lost, automatically, from evidence anyone can check." | Overview, the six steps |
| 0:45 | "A Chainlink CRE workflow builds a price band from sources the broken oracle can't touch: the Lido rate, the Uniswap TWAP and off-chain prices. Then it asks whether the position was healthy across the whole band." | Replay |
| 1:05 | Press **Play**. "The oracle falls below the band in the first block. This is the real incident, from real chain data." | Replay running |
| 1:30 | "47 events through the real workflow. We pay the provable floor: 473.3 ETH, 7.6% under the DAO's figure, by design. Zero false positives on 275 real liquidations, including the August 2024 crash." | Overview table, then Live controls |
| 1:55 | Enter `0x4f962BB0EA0785c539f8ab52a17f1f873DDc355f`. "Anyone can check. This reads from Arkiv." | Was I wronged? |
| 2:10 | "The operator's bond pays first, then the reserve, and a claim opens against the liquidator and the builder." | Reserve, then the Sepolia transaction logs |
| 2:30 | "This is the Live monitor on real recent liquidations. On a normal day it reads VALID." | Live |
| 2:45 | "It runs on testnets with a mock forwarder, and one manipulated source can still block a payout. Next: a production forwarder and more independent sources." | Overview |

**Keep it true.** The PRD's script in section 14.2 was written before the results and is out of date, so use this one. In particular, do not say:

| Do not say | Say |
|---|---|
| "34 of 34" | "33 of 34 positions wrongful on every event" |
| "Within 2% of the DAO" | "7.6% under, by design" |
| "Refund", "reversal" or "compensation" | "Economic restitution", and that payouts are test tokens |
| "Evidence on Swarm" | Nothing. It is not built |
| "The hook was used in the replay" | "The replay uses the v3 TWAP. The v4 hook is a synthetic demo" |
| "CRE consensus verified this" | "A local CRE simulation, on one node" |
| A real operator's name | "A demo operator" |

### Likely questions

| Question | Answer |
|---|---|
| Why is your number lower than the DAO's? | We pay the floor, the worst case across the band. Our midpoint estimate is 2.54% under |
| What stops a fake report? | In this demo, nothing: the mock forwarder accepts anyone. That is why it holds test tokens. Production uses the signature-checking forwarder |
| What if a price source is manipulated? | It cannot raise a payout. Today it can block one, and control 5 shows that |
| How is a real crash told apart from a glitch? | The independent band falls with the market. On 2024-08-05, 60 tested events gave no false positives |
| Who funds the reserve? | The PRD's design is a protocol or DAO, with operators' bonds paying first |
| Can the bond be escaped? | A withdrawal waits 7 days and lapses a day later. An operator who keeps re-requesting still gets a window, and a pending request is public |
| Why Arkiv rather than a database? | Anyone can run the same query without trusting our server. See `arkiv/why-arkiv.md` |

---

## If something goes wrong

The troubleshooting table is at the end of [`run_commands.md`](run_commands.md). The two most likely problems during a demo:

- **The lookup says "local JSON file".** Arkiv's anonymous budget ran out. The data is still right. Add `ARKIV_ACCESS_KEY` and restart the site.
- **`forge` or `cre` is not found.** Run the `export PATH` line in Setup.
