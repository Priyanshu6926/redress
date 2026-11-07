# Explore Redress

A guided way through the project, from a five-minute look to giving the demo. Pick the path that fits.

**Fastest look: open the live site, https://rachit-kale.github.io/redress/. It needs no setup.**

| You want to | Go to | Time |
|---|---|---|
| Run the entire project, in order | [Step by step](#run-the-entire-project-step-by-step) | 15 to 25 minutes |
| See it working | [1. See the product](#1-see-the-product) | 5 minutes |
| Check the claims yourself | [2. Verify it on-chain](#2-verify-it-on-chain) | 10 minutes |
| Understand the code | [3. Read the code](#3-read-the-code) | 30 minutes |
| Run the tests | [4. Run the tests](#4-run-the-tests) | 1 to 10 minutes |
| Watch a real liquidation go through | [5. Run one liquidation](#5-run-one-liquidation-yourself) | 10 minutes |
| Give the demo | [6. Give the demo](#6-give-the-demo) | 3 minutes |

Other documents: [`documentation.md`](documentation.md) explains every file, and [`run_commands.md`](run_commands.md) lists every command.

## Which terminal to use

**Use Git Bash for everything.** Open it from the Start menu, or right-click in the `redress` folder and choose **Open Git Bash here**.

`bun test` and `forge test` also work in PowerShell, but the fork and deploy scripts are bash, and so is the line that loads `.env`. Using one terminal avoids surprises.

## Run the entire project, step by step

Follow these in order. Parts A to D take about 15 minutes. Part E is optional and adds 10 minutes.

Nothing here touches a public network or spends anything. The Sepolia contracts and the Arkiv data are already live, so you do not redeploy them.

### Part A: Prepare (once per terminal)

**1. Go to the project.**

```bash
cd "/d/CAREER/Hackathon/ETHGlobal Mumbai/redress"
```

**2. Put the tools on your PATH.** Repeat this in every new terminal.

```bash
export PATH="$HOME/.foundry/bin:$HOME/.cre/bin:$PATH"
```

To make it permanent, run this once, then reopen Git Bash:

```bash
echo 'export PATH="$HOME/.foundry/bin:$HOME/.cre/bin:$PATH"' >> ~/.bashrc
```

**3. Check the tools.**

```bash
bun --version      # 1.4.4
forge --version    # 1.5.1
cre version        # v1.39.0
python --version   # 3.13
```

**4. Install packages.** Only needed the first time, or after `package.json` changes.

```bash
bun install
(cd cre/sentinel-verdict && bun install)
```

**5. Check `.env` has its five values.** This prints the names only.

```bash
grep -oE '^[A-Z_]+=.' .env
```

Expect `ETHERSCAN_API_KEY`, `MAINNET_RPC`, `SEPOLIA_RPC`, `CRE_ETH_PRIVATE_KEY` and `ARKIV_ACCESS_KEY`.

**6. Load `.env` into this terminal.** The Foundry fork tests need it.

```bash
set -a; . <(tr -d '\r' < .env); set +a
```

**7. Check the Chainlink login.** Only needed for Part E.

```bash
cre whoami
```

If it says you are not logged in, run `cre login`.

### Part B: Run the tests

**8. Run the TypeScript tests.**

```bash
bun test
```

Expect `150 pass` and `0 fail`.

**9. Check the types.**

```bash
bun run typecheck
```

Expect no errors.

**10. Generate the random test cases.** Only needed the first time.

```bash
bun run vectors:random
```

**11. Run the quick Solidity tests.** Under a minute.

```bash
(cd contracts && forge test --no-match-contract Invariant)
```

Expect every test to pass.

**12. Run all the Solidity tests.** About 9 minutes. Skip this if you are short of time.

```bash
(cd contracts && forge test)
```

Expect `115 tests passed, 0 failed, 0 skipped`. If 3 are skipped, go back to step 6.

### Part C: Produce the results

**13. Run the offline replay.** This judges all 47 events.

```bash
bun run replay
```

Expect 46 `WRONGFUL` and 1 `AMBIGUOUS` under the default config.

**14. Compare with the DAO's figures.**

```bash
bun run scorecard
```

Expect a floor of 473.2955 ETH, 7.594% under 512.19.

**15. Run the negative controls.**

```bash
bun replay/controls.ts
```

Expect 6 `PASS` and 1 `FAIL`. Control 5 is a known result, not a broken setup.

**16. Scan recent real liquidations.** About a minute.

```bash
bun backend/watcher.ts
```

Expect a line like `scanned 26143268 to 26359268: 17 events`. The numbers change over time.

### Part D: Run the website

**17. Start the site.** Leave this terminal running.

```bash
bun backend/api.ts
```

Expect `Redress on http://localhost:3001`.

**18. Open http://localhost:3001 in your browser** and follow [section 1](#1-see-the-product).

**19. Stop the site** with `Ctrl+C` when you finish.

### Part E: Run a real liquidation through Chainlink CRE (optional)

This uses three terminals. In each new one, repeat steps 1 and 2.

**20. Terminal 1: start the local fork.** Leave it running.

```bash
bun run fork:up
```

**21. Terminal 2: start the price server.** Leave it running.

```bash
bun run snapshot:serve
```

**22. Terminal 3: deploy a vault on the fork.**

```bash
bun run fork:deploy
```

Expect `funded with 3000ether`.

**23. Terminal 3: run one liquidation.** About a minute.

```bash
bun replay/mirror.ts fork --limit 1
```

Expect `1/47 WRONGFUL 230533099950029831035 vault tx 0x…`.

To run all 47, use `bun run replay:fork` instead. That takes about 50 minutes and ends with `paid 473295500496135010048 wei`.

**24. Stop terminals 1 and 2** with `Ctrl+C`.

**25. Restore the committed results,** because this run overwrote them.

```bash
git checkout replay/out/mirror-fork.json docs/transcripts/fork.txt deployments/fork.json cre/sentinel-verdict/config.fork.json
```

### What you have run

| Step | What it proved |
|---|---|
| 8 to 12 | The code is correct |
| 13 to 15 | The verdicts and controls give the published results |
| 16 | The engine works on today's mainnet data |
| 17 to 18 | The product works, reading from Arkiv |
| 20 to 23 | The real CRE workflow reaches the same answer as the offline replay |

The Sepolia payouts were made by `make mirror` earlier. Don't rerun that, because it needs a new deployment. To check them instead, see [section 2](#2-verify-it-on-chain).

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

Follow [Part E](#part-e-run-a-real-liquidation-through-chainlink-cre-optional) above. It runs the real CRE workflow on a local fork, and touches no public network.

Then open `docs/transcripts/fork.txt` before step 25 to see the simulator's output, and find `REDRESS_RESULT`.

The fork vault has no bond, so this pays from the reserve only. To see the bond waterfall, use the Sepolia links in section 2.

---

## 6. Give the demo

The main demo runs in a browser, on the live site. You don't need a terminal, keys or any local setup.

**Your message in one line:** Redress re-ran a real incident through a real pipeline, and every claim can be checked on-chain. The website is a window onto that, not the product itself.

### Part A: The day before

**1. Rehearse out loud with a timer.** Aim for 2 minutes 45 seconds, so you have room for a slow page.

**2. Record the rehearsal as your backup.** Save the video to your laptop, not only to the cloud.

**3. Check the live site opens on a phone,** using mobile data. This proves it works away from your own network.

**4. Decide who does what,** if you're presenting as a team: one person talks, and one person clicks.

### Part B: Ten minutes before

**5. Close everything you don't need,** including notifications and other browser tabs.

**6. Open these four tabs, in this order.**

| Tab | Open | Prepare it |
|---|---|---|
| 1 | [Live site](https://rachit-kale.github.io/redress/) | Stay on Overview |
| 2 | [CRE transcript](https://github.com/Rachit-Kale/redress/blob/main/docs/transcripts/sepolia.txt) | Press `Ctrl+F`, search for `REDRESS_RESULT`, and leave it highlighted |
| 3 | [Sepolia payout](https://sepolia.etherscan.io/tx/0xc7ca7d754a1d35fe5648996103cf1b2fd2db0b4d35b3424e38a31309b724fdb0) | Click the **Logs** tab, and find the two `Paid` events |
| 4 | [Vault code](https://github.com/Rachit-Kale/redress/blob/main/contracts/src/RedressVault.sol) | Press `Ctrl+F` and search for `function _pay`. Only for questions |

**7. Copy this address** into a note you can reach quickly:

```text
0x4f962BB0EA0785c539f8ab52a17f1f873DDc355f
```

**8. Warm up the site.** Click every page once, then try the address on **Was I wronged?**. This also confirms Arkiv is answering. Return to **Overview**.

**9. Zoom the browser to 125%** with `Ctrl` and `+`, so the back of the room can read it.

**10. Have your backup video open,** paused at the start.

### Part C: The demo (3 minutes)

**Step 1. The problem (0:00 to 0:25). Tab 1, Overview.**

- **Do:** Stay on the page. Point at the headline.
- **Say:** "On 10 March 2026 a misconfigured oracle undervalued wstETH on Aave, and healthy positions were liquidated. The repair was a slow, manual DAO process. You can't undo a liquidation, but you can restore what was lost, automatically, from evidence anyone can check."

**Step 2. How it works (0:25 to 0:40). Same page.**

- **Do:** Scroll to the six numbered boxes.
- **Say:** "Six steps: detect the liquidation, price it independently, judge it, pay, charge the operator's bond, and open a claim to recover the money."

**Step 3. The incident (0:40 to 1:15). Tab 1, Replay.**

- **Do:** Click **Replay**, then **Play**. It runs through 8 blocks in about 7 seconds.
- **Say while it plays:** "This is real mainnet data, block by block. The black line is Aave's oracle. The grey boxes are independent prices from Lido, Uniswap and off-chain sources, which the broken oracle can't touch. The oracle drops below them in the first block and stays there."
- **Do:** When it stops, point at the cumulative redress box.
- **Say:** "47 liquidations, and 473 ETH of provable loss."

**Step 4. Prove it's real (1:15 to 1:55). Tabs 2 and 3.** This is the most important moment.

- **Do:** Switch to tab 2. Point at the highlighted `REDRESS_RESULT` line.
- **Say:** "That wasn't an animation. This is the real Chainlink CRE workflow judging that liquidation: it read mainnet, built the band, and wrote a report to the vault."
- **Do:** Switch to tab 3. Point at the first `Paid` event, then the second, then `ClaimOpened`.
- **Say:** "And this is the transaction it produced. In one transaction the vault re-checked the amount, paid 100 from the oracle operator's bond, paid the remaining 130 from the reserve, and opened a claim against the liquidator and the block builder. These are test tokens, but this is a real contract on a public chain."

**Step 5. Anyone can check (1:55 to 2:15). Tab 1, Was I wronged?**

- **Do:** Click **Was I wronged?**, paste the address, and click **Check**.
- **Do:** Point at "Read from Arkiv" and at the Payout link.
- **Say:** "A victim doesn't have to trust us. This verdict comes from Arkiv, and it links to the real payout."

**Step 6. It doesn't cry wolf (2:15 to 2:35). Tab 1, Live.**

- **Do:** Click **Live**, then scroll to **Negative controls**.
- **Say:** "A system that pays people must not pay wrongly. We tested 275 real liquidations, including the August 2024 market crash. Zero false positives, because the independent band falls with a real market."
- **Do:** Point at the row marked **No**.
- **Say:** "One control fails, and we kept it visible: a manipulated source can block a payout, though it can't cause a wrong one."

**Step 7. Be honest, then close (2:35 to 3:00). Tab 1, Overview.**

- **Do:** Click **Overview**, and point at the comparison table.
- **Say:** "We pay only what we can prove: 473.3 ETH, 7.6% under the DAO's figure, by design. Today this is a testnet demo with a mock forwarder, and CRE ran as a local simulation. The next step is deploying on the CRE network, so a protocol can fund a vault and this runs by itself. Oracle failures shouldn't take weeks to repair."

### Part D: Sponsor add-ons

Use one of these if a sponsor's judges are in front of you, or if you have extra time.

**Chainlink (30 seconds).** Open `cre/sentinel-verdict/handler.ts` on GitHub.

- **Say:** "The whole pipeline is one workflow: it reads mainnet and Sepolia, calls an off-chain source with consensus, and writes a report. All 47 events went through it on Sepolia and on a fork, and matched our offline replay to the wei."

**Uniswap (30 seconds).** Open the [hook on Etherscan](https://sepolia.etherscan.io/address/0xc555e1ca0a109a1f02d238455ff4feda7ba5d080#code).

- **Say:** "Uniswap is in every verdict: the v3 TWAP is one of our price sources. We also built a v4 hook that gives any pool a TWAP and a price band. To be clear, its pool is synthetic, and it wasn't used in the replay."

**Arkiv (30 seconds).** Stay on the Explorer page, and set **Min redress** to `20`.

- **Say:** "That filter runs on Arkiv, in your browser, with no server of ours. We published 128 entities, and claims expire by themselves after 7 days."

**Technical judges (30 seconds).** Open tab 4, at `_pay`.

- **Say:** "Bond first, then reserve, then a claim. Before this, the vault re-derives the amount itself and reverts if it differs by one wei."

**Business judges (30 seconds).** Open **Reserve** and scroll to the stress calculator. Set **Reserve** to `500`.

- **Say:** "This replays the incident under your settings. With a smaller reserve, the epoch cap holds, and payouts queue instead of draining it."

### Part E: Optional live run

Only do this if judges ask to see it run, and only if you practised it. It takes about a minute, and depends on your network.

**1.** Before the demo, complete steps 1, 2, 20, 21 and 22 of [Part E above](#part-e-run-a-real-liquidation-through-chainlink-cre-optional), and leave those terminals open.

**2.** When asked, run this in terminal 3:

```bash
bun replay/mirror.ts fork --limit 1
```

**3.** Expect `1/47 WRONGFUL 230533099950029831035 vault tx 0x…`.

**4.** **Say:** "That is the real workflow running now, on a local fork of mainnet, reaching the same answer to the wei."

If you've already run all 47 on that fork, this does nothing, because the run resumes. Run `bun run fork:deploy` first.

### Part F: If something goes wrong

| Problem | What to do |
|---|---|
| The page says "local JSON file" | Keep going. Say: "Arkiv didn't answer in time, so the fallback served the same data" |
| The Etherscan tab is slow | Show the transcript tab, and return to it later |
| The site won't load | In Git Bash, run `bun backend/api.ts`, and open http://localhost:3001 |
| The internet fails | Play your backup video |
| You run out of time | Skip Step 2, and go straight from Step 5 to Step 7 |
| You forget a number | Point at the screen. All the key numbers are on Overview |

### Likely questions

| Question | Answer |
|---|---|
| Is this a real product or a website? | The website is a window onto it. The workflow, vault, bond and claims are real, and they ran on-chain. It's a replay today, and it doesn't yet watch mainnet by itself |
| Could it be integrated today? | The contracts and workflow are built for it. Production needs Chainlink Early Access, an audit, and a protocol or DAO to fund a vault |
| Why is your number lower than the DAO's? | We pay the floor, the worst case across the band. Our midpoint estimate is 2.54% under |
| Why 33 of 34 positions? | One position sat so close to the threshold that it came out `AMBIGUOUS`, so it was paid only its provable excess |
| What stops a fake report? | In this demo, nothing: the mock forwarder accepts anyone. That is why it holds test tokens. Production uses the signature-checking forwarder |
| What if a price source is manipulated? | It cannot raise a payout. Today it can block one, and control 5 shows that |
| How is a real crash told apart from a glitch? | The independent band falls with the market. On 2024-08-05, 60 tested events gave no false positives |
| Who funds the reserve? | The PRD's design is a protocol or DAO, with operators' bonds paying first |
| Can the bond be escaped? | A withdrawal waits 7 days and lapses a day later. An operator who keeps re-requesting still gets a window, and a pending request is public |
| Can it force a liquidator to repay? | No. Claims are public records. Recovery depends on someone paying in |
| Why Arkiv rather than a database? | Anyone can run the same query without trusting our server. See `arkiv/why-arkiv.md` |
| Was it audited? | No. We did a self-review, and every finding is in `docs/SECURITY.md` |
| How was AI used? | Claude Code wrote most of the code, tests and docs, under our direction. The README has the detail |

### What not to say

The PRD's script in section 14.2 was written before the results and is out of date, so use this one.

| Do not say | Say |
|---|---|
| "34 of 34" | "33 of 34 positions wrongful on every event" |
| "Within 2% of the DAO" | "7.6% under, by design" |
| "Refund", "reversal" or "compensation" | "Economic restitution", and that payouts are test tokens |
| "Three weeks" | "A slow, manual process". We did not verify the duration from chain data |
| "Evidence on Swarm" | Nothing. It is not built |
| "The hook was used in the replay" | "The replay uses the v3 TWAP. The v4 hook is a synthetic demo" |
| "CRE consensus verified this" | "A local CRE simulation, on one node" |
| "It's live on mainnet" | "It replays real mainnet history, and pays on testnet" |
| A real operator's name | "A demo operator" |

---

## If something goes wrong

The troubleshooting table is at the end of [`run_commands.md`](run_commands.md). The two most likely problems during a demo:

- **The lookup says "local JSON file".** Arkiv did not answer in time. The data is still right. Check `ARKIV_ACCESS_KEY` and restart the site.
- **`forge` or `cre` is not found.** Repeat step 2.
