# Verification register

The deploy scripts refuse to run until `VERIFY_CLEARED=true` is set, which must only happen when the deployment table below is empty. Addresses are never guessed: each confirmed row names its source.

## Open: blocks deployment

| Item | Why it is open | What clears it |
|---|---|---|

## Open: blocks the mirror, not deployment

| Item | Why it is open | What clears it |
|---|---|---|

## Confirmed

| Item | Value | Source |
|---|---|---|
| `IReceiver` interface | `onReport(bytes,bytes)` with ERC165 | [docs sample](https://docs.chain.link/samples/CRE/IReceiver.sol) |
| Metadata layout | 32-byte workflow id, 10-byte name, 20-byte owner; 64 bytes on production delivery, 2-byte report id appended | [Building consumer contracts](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts.md) |
| Simulation metadata | `MockKeystoneForwarder` does not provide it, and identity checks must stay unset in simulation | Same page, section 4 |
| Sepolia simulation forwarder | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` | [Forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts.md); code present per `replay/data/verification-report.txt` |
| Sepolia production forwarder | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | Same; code present |
| Mainnet simulation forwarder | `0xa3d1ad4ac559a6575a114998affb2fb2ec97a7d9` | Same; 4,579 bytes of code on mainnet |
| CRE quotas | 15 HTTP calls, 15 EVM reads, 50 KB report, 10M gas, 5 log-trigger addresses, 100-block log queries | [Service quotas](https://docs.chain.link/cre/service-quotas.md) |
| Aave addresses and bonus logic | Registry reads and fork tests | `replay/data/verification-report.txt`, `contracts/test/fork/AaveBonus.fork.t.sol` |

## Measured in a real simulation

`docs/transcripts/fork.txt`: one incident liquidation through `cre workflow simulate --broadcast` on the fork. Historical reads at a chosen block, the local HTTP snapshot, bigint median consensus, the `receiver` encoding and the mock forwarder write all worked, and the result matched the offline replay.

`docs/transcripts/sepolia.txt`: the same event through `--target sepolia --broadcast`. One simulation read mainnet history and wrote to the Sepolia mock forwarder, which settles the cross-chain question. Vault transaction `0xe823565fb68bdd53bfca824c2e0f72d82da3a4c208b98c9d74c275de53bd50a9` paid 230533099950029831035 wei, equal to the offline replay.

## Measured on Sepolia

Sepolia's gas schedule is not the one Foundry 1.5.1 simulates, so forge's estimates do not transfer. Node estimates and receipts:

| Operation | Forge or fork | Sepolia |
|---|---:|---:|
| Plain transfer | 21,000 | 12,000 |
| `MockWETH` create | 507,940 | 3,315,394 |
| `RedressVault` create | 1,359,377 | 9,480,591 |
| Report through the forwarder | 216,575 | 851,647 |

A report through the final vault used 1,774,377 gas, because each payout now also writes a claim, so the Sepolia gas limit is 3,000,000.

The first deployment attempt ran out of gas on both creates at forge's default 130% limit. It left no code at either address and cost about 0.0000025 ETH. `replay/deploy-sepolia.sh` now uses a 1000% multiplier, and raised the Sepolia workflow gas limit. Neither changes verdict logic or payout data. The cause of the schedule change was not investigated.

## Superseded Sepolia deployments

These contracts are on Sepolia but are not the final system. Nothing current uses them.

| Contract | Address | Why it was replaced |
|---|---|---|
| Vault v1, reserve-only | `0x73278c1e2b1a2d9d129955369c32aa4aeef4fbf9` | No bond or claims. Its 47 payouts are kept in `replay/out/mirror-sepolia-v1.json` |
| `BandOracleHook` | `0x301eb55a7d1e5528771857aceef4714af34b5080` | Built before design approval, on `IHooks` directly |
| `OperatorBond`, attestor version | `0xbd41374a100de606970fa787033e7eda97688cca` | Built before the Phase 3 brief |
| `RecoveryLedger`, attestor version | `0x0e11c9be0b6d88c0b5ebb05eb1150181a578060a` | Built before the Phase 3 brief |
| Interim vault | `0x72841568bdebb14fed50a1b7a47ed71ce6356b64` | Bond-first, but before the security fixes. Stopped after 14 events |
| Interim bond | `0x1e07ced6f24d4ff74235b4be64e7ab8efe389d84` | Had the withdrawal and squatting flaws in `docs/SECURITY.md` |
| Interim ledger | `0x8ab383c7cbcd2b3f6ac0e3671f46e71f3c3f7bb6` | Paired with the interim vault |

The final contracts were verified on Etherscan before `forge fmt` ran, so the repo's Solidity differs from the verified source in whitespace only.

## Uniswap v4 on Sepolia

Addresses come from the [v4 deployments page](https://developers.uniswap.org/docs/protocols/v4/deployments), and activity was read from Etherscan on 2026-11-07. `docs/HOOK_DESIGN.md` lists them. The demo hook pool is synthetic and took no part in the mainnet replay.

## Decided

| Item | Decision |
|---|---|
| Payout asset on Sepolia | Deploy our own `MockWETH`, as no official test WETH address is confirmed |
| Forged reports through the mock forwarder | Accepted for a test-token Sepolia demo and disclosed in the README. Production forwarding needs a deployed workflow, which needs Early Access `[REPORTED]` |

## Measured trust findings

- **`MockKeystoneForwarder` delivers forged reports from any sender.** `contracts/test/fork/MockForwarder.fork.t.sol` sends a report from an arbitrary address with no signatures, and the mainnet mock delivers it. It was run against mainnet. On Sepolia, an `eth_call` from `0x…dEaD` with no signatures did not revert at the mock, using a real report and the deployed vault. That call changed no state, so forged delivery there is shown by simulation only, and the fork test remains the only measured payout from a forged report. A vault using the mock can be emptied by anyone who writes a report whose arithmetic is consistent, so it must only ever hold test tokens.
- **The vault re-derives arithmetic, not facts.** It cannot see mainnet. It trusts the report for `user`, `C`, `X`, the band, the bonus, the verdict and the finality of the liquidation. Strict equality proves the redress follows from the reported fields, not that the fields are true. In production that trust rests on CRE consensus.
