# Security review

A self-review of `RedressVault`, `OperatorBond`, `RecoveryLedger`, `BandOracleHook` and `VerdictMath`, done by the author on 2026-11-07. **It is not an independent audit.** These contracts hold test tokens only.

Scope: access control, reentrancy, rounding, replay, pause behaviour and forwarder trust.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High in production, accepted for this demo | The mock forwarder accepts anyone's report | Accepted, disclosed |
| 2 | Medium | A standing withdrawal request bypassed the bond's delay | **Fixed** |
| 3 | Low to medium | The first depositor could squat an adapter | **Fixed** |
| 4 | Medium | One manipulated source can block a legitimate payout | Open, fails safe |
| 5 | Medium | The vault trusts the report for facts it cannot see | Accepted, by design |
| 6 | Low | A forged report can burn an event's idempotency key | Accepted, needs finding 1 |
| 7 | Low | Recoveries over-credit the reserve when a bond paid part | Open, disclosed |
| 8 | Low | Rolling withdrawal requests still give one exit window per cycle | Open, disclosed |
| 9 | Info | Hook band goes stale on a quiet pool | Exposed to consumers |

### 1. The mock forwarder accepts anyone's report

`MockKeystoneForwarder` checks no signatures and supplies no workflow identity. A fork test delivered a report from an arbitrary sender, and an `eth_call` shows the same on Sepolia. Anyone can write a report whose arithmetic is consistent and drain the reserve, or draw the bond by naming the bonded adapter.

This is why the deployment holds test tokens only. Production needs the signature-checking `KeystoneForwarder`, with `expectedWorkflowId` and `expectedWorkflowOwner` set. Those checks exist and are tested, but simulation cannot exercise them.

### 2. A standing withdrawal bypassed the delay: fixed

An operator could request a withdrawal once, wait out the 7-day delay, and leave the request standing. From then on they held an instant exit, usable the moment an incident happened and before the report landed.

Requests now lapse one day after the delay ends. Tests: `test_bond_standingWithdrawalLapses`, `test_bond_withdrawalWorksUntilTheWindowCloses`. See finding 8 for what remains.

### 3. Adapter squatting: fixed

The first depositor became an adapter's operator, so a dust deposit could permanently lock the real operator out. Operators are now named once by a registrar, which has no other power. Tests: `test_bond_dustCannotSquatAnAdapter`, `test_bond_registrationIsWriteOnce`.

The registrar is a new trust point: it decides who may bond against an adapter, though it cannot move funds.

### 4. One manipulated source can block a payout

Negative control 5 fails. Pushing one source 5% off did not change a payout upward, but it turned a WRONGFUL verdict into INCONCLUSIVE. CoinGecko is already rejected as an outlier, so only three good sources remain, and rejecting one falls below `minSources`.

This fails safe: nobody is wrongly paid. But it means an attacker who can move one source can deny a legitimate payout. A further independent source would close it. Nothing was tuned to make this control pass.

### 5. The vault trusts the report

The vault re-derives the arithmetic, not the facts. It cannot see mainnet, so it trusts the report for the position, band, verdict, adapter, liquidator and builder. Strict equality proves the redress follows from the reported fields, not that they are true. In production that trust rests on CRE consensus.

### 6. Burning an idempotency key

A forged report for a real `(tx, logIndex)` would mark it processed, so the genuine report would revert. This needs finding 1, and it is gone with a signature-checking forwarder.

### 7. Recoveries can over-credit the reserve

A claim's expected amount is the whole redress, and recoveries go to the reserve. If a bond paid part of that redress, a full recovery leaves the reserve above where it started, and the operator is not repaid. This needs a rule for sharing recoveries between bond and reserve.

### 8. Rolling withdrawal requests

An operator who keeps re-requesting still gets a one-day exit window in each eight-day cycle. Any exit delay has this limit. A pending request is public through `bondOf` and should be read as reduced cover.

### 9. Hook staleness

The hook records only when the pool trades. `count`, `coveredSeconds` and `lastObservedAt` expose this, and the `v4Hook` source fails closed on too few or too old observations.

## The live demo contracts

`contracts/src/demo/` and the vault deployed with them hold a small amount of real test ETH.

- **Anyone can drain them.** They use the mock forwarder, as in finding 1, and the page itself sends the report, so a user could send a forged one. The deposit cap and the 20% epoch cap limit the rate, not the outcome.
- **`DemoWETH` calls the recipient** when a marked sender transfers. The vault and bond guards cover this, but it is a demo convenience and should not be copied.
- **The price sources are synthetic,** so its verdicts demonstrate the mechanism rather than judge a market.

## Checked and clean

| Area | Result |
|---|---|
| Access control | `onReport` is forwarder-only. `draw` and `openClaim` are vault-only. Pause is the owner's only vault power. Bond and ledger are bound to the vault at construction, and the vault checks them, so no setter exists |
| Reentrancy | All token-moving entry points use `nonReentrant`, and state is written before tokens move. The payout asset has no transfer hooks |
| Rounding | Every rounding choice works against the payout. The Python reference vectors and fuzz tests agree with both implementations |
| Replay | One record per `(tx, logIndex)`. A duplicate reverts and draws no bond (`test_waterfall_duplicateCannotDrawTwice`) |
| Pause | Verdicts are still recorded. Payouts queue, the bond is untouched, and `settle` reverts until unpaused (`test_waterfall_pausedPayoutQueuesAndDrawsNothing`) |
| A ledger failure cannot block a victim | `openClaim` has no revert path on a call from the vault, and a report with no liquidator still pays (`test_ledger_missingLiquidatorStillPaysTheVictim`) |
| Accounting | Invariants at 256 runs × 500 calls: paid never exceeds funded plus recovered, the vault holds exactly its reserve, the bond holds exactly what is bonded, victims received exactly both shares, and claims cover every payout |

## Not covered

- No external auditor has read this code.
- `BandOracleHook` has no invariant suite, only unit tests.
- OpenZeppelin's `BaseHook` describes itself as experimental software.
