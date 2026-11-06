# Uniswap developer feedback

Written as we built, from problems we actually hit. The feedback form at `https://developers.uniswap.org/hackathon-feedback` still has to be submitted with a link to this file.

## What worked

- **v4-core test utilities.** `Deployers` plus Foundry's `deployCodeTo` gave a real PoolManager and routers in a few lines, with a hook at a flagged address and no mining in tests.
- **Address validation.** `Hooks.validateHookPermissions` rejected a wrongly flagged address at construction, so the mistake surfaces at once.
- **The Sepolia deployments table.** Every address we used had code and recent transactions. `PoolSwapTest` and `PoolModifyLiquidityTest` made it easy to open a pool and run swaps from a script.
- **`v4-template`.** Its imports were the only reliable answer to where `BaseHook` now lives.

## What blocked us

- **The hook guide points to a file that no longer exists.** The guide imports `BaseHook` from `v4-periphery/src/utils/BaseHook.sol`. That file was removed on 2026-02-06 in commit `5da22e60` ("remove hooks and move to hook repo"). The commit does not say which repo, and `Uniswap/v4-hooks` is a 404. We found the answer only by reading `v4-template`, which uses OpenZeppelin `uniswap-hooks`. The first build failed on this import path.
- **`forge script` runs out of gas on Sepolia.** Sepolia's costs differ from what Foundry 1.5.1 simulates: the node estimated 9,557,013 gas for a contract create that forge estimated at 1,359,377. Both creates in our first deployment failed at the default 130% limit, and forge reported the failures against the wrong calls. We raised `--gas-estimate-multiplier` to 1000. This is not a Uniswap bug, but anyone following a hook tutorial on Sepolia will hit it.

## Missing documentation

- **Which Sepolia Universal Router to use.** The deployments page lists three: one in its table, plus 2.1.1 and 2.1.2. All three are active, and the page does not say which is current.
- **`HookMiner` has no public home.** It sits in `v4-periphery/test/shared/`, so a deploy script has to import from another project's test folder.
- **An oracle hook example.** We found no maintained example of recording observations in a v4 hook. The cumulative tick rule is easy to get wrong: our first version credited each interval to the wrong tick, and only a time-weighting test caught it.

## The one highest-impact fix

Update the hook guide to import `BaseHook` from OpenZeppelin `uniswap-hooks`, and add one line to the v4-periphery README saying where it went. It is a small change, and it is the first error a new hook developer sees.
