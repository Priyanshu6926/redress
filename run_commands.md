# Run commands

Every command in this project, and what to run during the hackathon.

## Before you start

- **Use Git Bash, not PowerShell.** The scripts and the `VAR=value command` form need bash.
- **Run commands from the `redress` folder**, unless a block says otherwise.
- **`make` is not installed on this machine.** Each `make` target below has a direct command, so use that one.
- **Tools must be on your PATH.** If `forge` or `cre` is not found, run:

```bash
export PATH="$HOME/.foundry/bin:$HOME/.cre/bin:$PATH"
```

- **Some Foundry commands read `.env` themselves, and some do not.** Bun loads `.env` automatically. For a raw `forge` or `cast` command that needs the RPC, load it first. This form handles the Windows line endings in `.env`:

```bash
set -a; . <(tr -d '\r' < .env); set +a
```

### `.env` values

| Name | Used for |
|---|---|
| `ETHERSCAN_API_KEY` | Log scans and contract verification |
| `MAINNET_RPC` | Archive reads. Must serve March 2026 state |
| `SEPOLIA_RPC` | The public mirror |
| `CRE_ETH_PRIVATE_KEY` | Testnet deployer. Also the Arkiv writer |
| `ARKIV_ACCESS_KEY` | Arkiv reads. Optional, but recommended before a demo |

Never paste these into chat, and never commit `.env`.

### Two commands with confusing names

| Command | What it does |
|---|---|
| `bun run replay` | The **offline** replay. Fast, no CRE, no chain |
| `make replay` or `bun replay/mirror.ts fork` | The **real CRE workflow** on a local fork. About 50 minutes |

---

## Daily routine for the hackathon

### 1. First time on a machine

```bash
git clone --recursive https://github.com/Rachit-Kale/redress
cd redress
bun install
(cd cre/sentinel-verdict && bun install)
cp .env.example .env     # then fill it in
bun run vectors:random   # the Forge parity test needs this generated file
```

Then log in to Chainlink. This one is interactive:

```bash
cre login
```

### 2. Start of each work session (2 minutes)

```bash
git status                 # anything uncommitted?
git pull                   # if a teammate pushed
bun test                   # should say 150 pass
bun run typecheck          # should print no errors
```

### 3. Before every commit

```bash
bun test
bun run typecheck
(cd contracts && forge fmt && forge test --no-match-contract Invariant)
```

That Foundry run takes under a minute. CI also fails on unformatted Solidity, and on any VERIFY marker in `README.md`.

### 4. After changing a contract

```bash
(cd contracts && forge test)     # the full run, with invariants: about 9 minutes
```

Add the fork tests by loading `.env` first, as shown above. Without `MAINNET_RPC`, 3 tests skip.

### 5. Before the demo (about 10 minutes)

**Terminal 1: the site**

```bash
bun backend/api.ts
```

**Terminal 2: fresh data for the Live page**

```bash
bun backend/watcher.ts
bun replay/controls.ts
```

The site picks these up on the next page load, with no restart.

**Browser:** open http://localhost:3001 and check each page:

| Page | Check |
|---|---|
| Overview | 473.2955 test WETH paid |
| Was I wronged? | Try `0x4f962BB0EA0785c539f8ab52a17f1f873DDc355f`. It should say "Read from Arkiv" and show 230.5330 ETH |
| Replay | Press Play |
| Explorer | Filter by `AMBIGUOUS`. It should return 1 result, served by Arkiv |
| Reserve | 100 from the bond, 373.2955 from the reserve |
| Live | Recent events and the controls table |

If the lookup says "local JSON file", Arkiv's anonymous budget has run out. The page still works, but add `ARKIV_ACCESS_KEY` to `.env` and restart the site.

### 6. Showing the hook on stage (optional)

The hook source needs 5 observations from the last 30 minutes, so refresh the pool first. This sends 8 real Sepolia transactions for almost no gas.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . <(tr -d '\r' < .env); set +a
export TOKEN0=$(python -c "import json;print(json.load(open('deployments/sepolia.json'))['hookPool']['token0'])")
export TOKEN1=$(python -c "import json;print(json.load(open('deployments/sepolia.json'))['hookPool']['token1'])")
export HOOK=$(python -c "import json;print(json.load(open('deployments/sepolia.json'))['bandOracleHook'])")
(cd contracts && forge script script/SwapHookPool.s.sol --rpc-url "$SEPOLIA_RPC" --private-key "$CRE_ETH_PRIVATE_KEY" \
  --broadcast --silent --slow --gas-estimate-multiplier 1000 --with-gas-price 2000 --priority-gas-price 100)
```

Then, with `bun replay/serve-snapshot.ts` running in another terminal:

```bash
bun replay/demo-v4hook.ts
```

Say plainly that the pool is synthetic and played no part in the incident.

### 7. Before submission

```bash
bun test
bun run typecheck
(cd contracts && forge test)
grep -nE '\[VERIFY\]|TODO-VERIFY' README.md   # must print nothing
git status                                    # must be clean
```

Then work through `SUBMISSION_CHECKLIST.md`.

### Commands to avoid during the demo

| Command | Why |
|---|---|
| `bash replay/deploy-sepolia.sh` | Deploys a new vault. Every published transaction would then point at the old one |
| `bash replay/deploy-hook.sh` | Deploys a new hook and a new pool |
| `bun run offchain` | Overwrites the committed price snapshot, so results may no longer match |
| `bun run replay:fetch` | Rewrites the cached incident reads |
| `bash replay/fork-deploy.sh` | Deletes `replay/out/mirror-fork.json` |

---

## Every command

### Install and setup

| Command | What it does |
|---|---|
| `bun install` | Installs root packages |
| `(cd cre/sentinel-verdict && bun install)` | Installs workflow packages |
| `git submodule update --init --recursive` | Fetches the Solidity libraries, if you cloned without `--recursive` |
| `cre login` | Logs in to Chainlink CRE |
| `cre whoami` | Shows the CRE login |

### Tests

| Command | What it does | Time |
|---|---|---|
| `bun test` | All TypeScript tests | Seconds |
| `bun run typecheck` | Type-checks both TypeScript projects | Seconds |
| `(cd contracts && forge test)` | All Solidity tests | About 9 minutes |
| `(cd contracts && forge test --no-match-contract Invariant)` | Solidity tests without invariants | Under a minute |
| `(cd contracts && forge test --match-contract BandOracleHookTest)` | Hook tests only | Seconds |
| `(cd contracts && forge test --match-contract AccountabilityTest)` | Bond and ledger tests only | Seconds |
| `(cd contracts && forge test --gas-report)` | Solidity tests with a gas report | About 9 minutes |
| `(cd contracts && forge fmt)` | Formats Solidity | Seconds |
| `(cd contracts && forge fmt --check)` | Checks formatting, as CI does | Seconds |
| `(cd contracts && forge build)` | Compiles Solidity | Seconds |

### Website and API

| `make` target | Direct command | What it does |
|---|---|---|
| `make web` | `bun backend/api.ts` | Site and API on http://localhost:3001 |
| | `PORT=3010 bun backend/api.ts` | The same, on another port |
| `make watcher` | `bun backend/watcher.ts` | One live scan, written to `replay/out/live.json` |
| | `bun backend/watcher.ts --watch` | Rescans every 5 minutes |

**API routes:**

| Route | Returns |
|---|---|
| `/api/lookup/<address>` | Verdicts for an address. Arkiv first, then JSON |
| `/api/verdicts?verdict=&minMilliEth=&maxMilliEth=&fromBlock=&toBlock=` | Explorer query. Arkiv first, then JSON |
| `/api/replay` | `replay.json` |
| `/api/mirror` | Sepolia payouts |
| `/api/deployments` | Contract addresses |
| `/api/live` | Latest live scan |
| `/api/controls` | Negative control results |
| `/api/arkiv` | Writer wallet and counts |

### Offline replay and results

| `make` target | Direct command | What it does |
|---|---|---|
| | `bun run replay` | Runs the engine over cached data, under every config |
| `make scorecard` | `bun run scorecard` | Compares with the DAO figures and rebuilds `replay.json` |
| `make controls` | `bun replay/controls.ts` | Runs the seven negative controls |

### Real CRE runs

Each needs `cre login`, plus the snapshot server in another terminal.

| `make` target | Direct command | What it does |
|---|---|---|
| `make snapshot` | `bun run snapshot:serve` | Serves off-chain prices to the workflow on port 8787 |
| `make fork-up` | `bun run fork:up` | Starts a local mainnet fork on port 8545 |
| `make deploy-fork` | `bun run fork:deploy` | Deploys a vault on the fork. Deletes old fork results |
| `make replay` | `bun run replay:fork` | All 47 events through CRE on the fork. About 50 minutes |
| | `bun replay/mirror.ts fork --limit 1` | One event on the fork |
| `make mirror` | `bun run mirror` | All 47 events through CRE on Sepolia. About 50 minutes |
| | `bun replay/mirror.ts sepolia --limit 1` | One event on Sepolia |
| | `bun replay/demo-v4hook.ts` | The hook demo. A dry run that writes nothing |
| | `bun replay/rehearse-fork.ts` | Sends the reports straight through the mock forwarder, without CRE |

Both mirror commands resume from `replay/out/mirror-<target>.json`, so a failed run never pays twice. Against a vault that already paid every event, they do nothing.

**Full fork run:**

```bash
# terminal 1
bun run fork:up
# terminal 2
bun run snapshot:serve
# terminal 3
bun run fork:deploy
bun run replay:fork
```

**Full public redo.** This replaces every published vault transaction, so only do it on purpose:

```bash
# terminal 1
bun run snapshot:serve
# terminal 2
VERIFY_CLEARED=true bash replay/deploy-sepolia.sh
rm replay/out/mirror-sepolia.json
bun run mirror
bun run scorecard
rm replay/out/arkiv.json
bun replay/publish-arkiv.ts
```

### Deployment

These send real testnet transactions.

| `make` target | Direct command | What it does |
|---|---|---|
| `make deploy-sepolia` | `VERIFY_CLEARED=true bun run sepolia:deploy` | Bond, ledger and vault, verified on Etherscan. Refuses to run without `VERIFY_CLEARED=true`, on `make` too |
| `make deploy-hook` | `bash replay/deploy-hook.sh` | Hook, demo pool and swaps |

### Publishing the website

Free, on GitHub Pages: https://rachit-kale.github.io/redress/

| Command | What it does |
|---|---|
| `bun web/build.ts` | Builds the static site into `web/dist`. Fails if any `.env` value reaches the output |
| `bash web/deploy-pages.sh` | Builds and pushes to the `gh-pages` branch. The site updates about a minute later |

To refresh the Live page, run `bun backend/watcher.ts` and `bun replay/controls.ts` first.

### Arkiv

| `make` target | Direct command | What it does |
|---|---|---|
| `make arkiv` | `bun replay/publish-arkiv.ts` | Publishes everything not yet published. Already complete |
| | `bun replay/publish-arkiv.ts --limit 1` | Publishes one batch of 10 |

### Refreshing source data

You should not need these. They rewrite committed data, so commit first and compare the results afterwards.

| Command | What it does |
|---|---|
| `bun run verify` | Re-checks on-chain facts and rewrites `verification-report.txt` |
| `bun run fetch-incident` | Rebuilds the incident file from chain data |
| `bun run replay:fetch` | Re-reads archive state for the incident and the 50 controls |
| `bun run offchain` | Refetches off-chain prices. CoinGecko steps wait 15 seconds each |
| `bun replay/fetch-adapters.ts` | Re-reads each event's oracle adapter and coinbase |
| `bun replay/fetch-controls.ts` | Rebuilds the 275 wide control events. Slow. Resumes from its output file |

### Generated files

| Command | What it writes |
|---|---|
| `bun run vectors` | `contracts/test/vectors.json`, from the Python reference |
| `bun run vectors:random` | `contracts/test/vectors-random.bin`, gitignored |
| `bun run vectors:reports` | `contracts/test/report-fixture.json` |
| `bun run cre:config` | All three workflow configs, or name one: `bun run cre:config sepolia` |

### Checking the chain

Load `.env` first. Replace the addresses from `deployments/sepolia.json`.

```bash
cast call <vault> 'totalPaid()(uint256)' --rpc-url "$SEPOLIA_RPC"
cast call <vault> 'totalPaidFromBond()(uint256)' --rpc-url "$SEPOLIA_RPC"
cast call <vault> 'available()(uint256)' --rpc-url "$SEPOLIA_RPC"
cast call <ledger> 'totalExpected()(uint256)' --rpc-url "$SEPOLIA_RPC"
```

Expected: 373295500496135010048, 100000000000000000000, 2626704499503864989952 and 473295500496135010048.

---

## When something breaks

| Problem | Fix |
|---|---|
| `forge`, `cast` or `cre` not found | Run the `export PATH` line at the top of this file |
| `snapshot server is not running` | Start `bun run snapshot:serve` in another terminal |
| `not logged in to CRE` | Run `cre login` |
| `CRE login check timed out` | Transient. The mirror retries by itself up to 4 times |
| A mirror run stopped part way | Run the same command again. It resumes |
| A mirror says `belongs to another vault` | The results file is for an older deployment. Keep a copy, then delete it |
| Port 3001 is in use | `PORT=3010 bun backend/api.ts` |
| Port 8787 or 8545 is in use | A previous server is still running. Stop it, or use Task Manager |
| The site says "local JSON file" | Add `ARKIV_ACCESS_KEY` to `.env` and restart the site |
| An Arkiv query seems to hang | Reads time out after 8 seconds and fall back to JSON |
| `forge test` complains about `vectors-random.bin` | Run `bun run vectors:random` |
| 3 Foundry tests skip | Load `.env` first, so `MAINNET_RPC` is set |
| `bun replay/demo-v4hook.ts` shows no S4 source | The pool's data is stale. Run the swap command in step 6 |
| A Sepolia deploy runs out of gas | Keep `--gas-estimate-multiplier 1000`. Forge's estimates are far too low for Sepolia |
