# Submission checklist

Mapped to PRD section 13. **Done** means it exists and was checked. **Needs you** means only you can do it. **Blocked** means it waits on something else.

| Item | Needed by | Status | Notes |
|---|---|---|---|
| Public GitHub repo, MIT licence, readable history | All | Done | https://github.com/Rachit-Kale/redress |
| README: problem, how it works, diagram, setup, limitations, AI usage, trust assumptions | All | Done | [`README.md`](README.md) |
| Sponsor sections with file and line pointers | All | Done | Demo timestamps are missing until the video exists |
| Demo timestamps in sponsor sections | All | Blocked | Waits on the video |
| `FEEDBACK.md` | Uniswap | Done | [`FEEDBACK.md`](FEEDBACK.md) |
| Uniswap feedback form with the `FEEDBACK.md` link | Uniswap | **Needs you** | https://developers.uniswap.org/hackathon-feedback |
| `PRD.md` as design record | Judges | Done | Reconciled with measured results |
| Sepolia contracts verified on Etherscan | Uniswap, Chainlink, ETHGlobal | Done | Addresses in the README |
| CRE transcript with `--broadcast` and tx hashes | Chainlink | Done | [`docs/transcripts/sepolia.txt`](docs/transcripts/sepolia.txt), [`replay/out/mirror-sepolia.json`](replay/out/mirror-sepolia.json) |
| `arkiv/*.md` files | Arkiv | Done | Numbers filled from the real publish |
| Arkiv writer wallet and a runnable query | Arkiv | Done | [`arkiv/schema.md`](arkiv/schema.md) |
| Swarm batch ID, bundle link, entity key | Arkiv + Swarm | Not entering | The bonus needs Swarm in the project. It is not built, and this is a $500 add-on |
| Live demo link | ETHGlobal | Done | https://rachit-kale.github.io/redress/ on GitHub Pages, free |
| Demo video, under 3 minutes | ETHGlobal | **Needs you** | Script in PRD section 14 |
| Team names, Telegram and X handles | ETHGlobal | **Needs you** | |
| Backup recording of every demo step | Internal | **Needs you** | |
| Mentor confirmations: CRE and CCIP eligibility, three-pick rule, Arkiv and Swarm stacking | Internal | **Needs you** | |
| Say how AI was used | ETHGlobal, Arkiv | Done | README, AI usage |
| Set the `MAINNET_RPC` secret in GitHub | CI | **Needs you** | Fork tests skip without it |
| Rotate the Alchemy key | Security | **Needs you** | It was printed in session output earlier, and is not in the repo |

## Not built, by decision

- CCIP: you asked not to start it.
- Uniswap swap settlement (U2) and true-up payouts: PRD "Could" items, not started.

## Known results that miss a target

Report these plainly in the demo:

- 33 of 34 positions, not 34 of 34.
- The floor is −7.594% and the midpoint −2.541% against 512.19 ETH, outside ±2%.
- Negative control 5 fails: one manipulated source can block a legitimate payout.

## Sponsor asks, against the prizes page

Read from ethglobal.com/events/mumbai/prizes on 2026-11-07.

| Sponsor ask | Status |
|---|---|
| **Uniswap:** public repo, open source | Done |
| **Uniswap:** `FEEDBACK.md` | Done |
| **Uniswap:** completed feedback form | **Needs you.** Without it, the submission is audited before winners are finalised |
| **Uniswap:** README points to contracts and lines | Done, every pointer checked |
| **Chainlink:** CRE workflow as the orchestration layer | Done for the replay and mirror. The wallet Live Demo does not use it, and says so |
| **Chainlink:** a blockchain with an external source | Done: mainnet and Sepolia, with an HTTP price source |
| **Chainlink:** successful CLI simulation | Done: transcripts, 47 events on Sepolia and on a fork |
| **Chainlink:** CCIP prize | Not entered. Nothing here uses CCIP |
| **Arkiv:** "Build on Arkiv (from scratch)" | Entered track. All required files exist |
| **Arkiv:** writes to the current testnet, and a user feature reads it | Done: Rabdi, lookup and explorer |
| **Arkiv:** wallet and one query in the README | Done |
| **Arkiv:** AI usage stated | Done |
| **Arkiv:** "Built from scratch at ETHGlobal Mumbai" | **Needs you.** Confirm the project meets ETHGlobal's rules |
| **Arkiv:** `reach.md` (25% of the score) | **Needs you.** Whether it ships after Mumbai is still undecided, which is a weak answer |
