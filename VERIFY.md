# Verification register

The deploy scripts refuse to run until `VERIFY_CLEARED=true` is set, which must only happen when the deployment table below is empty. Addresses are never guessed: each confirmed row names its source.

## Open: blocks deployment

| Item | Why it is open | What clears it |
|---|---|---|
| CRE account access | `cre whoami` reports not logged in. `cre workflow supported-chains` is tenant-scoped and needs login | Run `cre login`, then confirm Ethereum Sepolia and the forwarder from that command |
| RPC configuration | `MAINNET_RPC` in `.env` currently answers chain id 11155111, which is Sepolia | Set `MAINNET_RPC` to a mainnet archive URL and add `SEPOLIA_RPC` |
| Deployer key | Not provided yet | Add `CRE_ETH_PRIVATE_KEY` to `.env`, funded with Sepolia ETH |

## Open: blocks the mirror, not deployment

| Item | Why it is open | What clears it |
|---|---|---|
| Mainnet read and Sepolia write in one simulation | The docs show a target with both RPCs and one client per chain, but no page states it for one run. Not yet run | The first `bun replay/mirror.ts sepolia --limit 1` |
| Real simulation of the workflow on any target | Only mocked tests have run, because CRE is not logged in | `bun replay/mirror.ts fork --limit 1` |

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

## Decided

| Item | Decision |
|---|---|
| Payout asset on Sepolia | Deploy our own `MockWETH`, as no official test WETH address is confirmed |
| Forged reports through the mock forwarder | Accepted for a test-token Sepolia demo and disclosed in the README. Production forwarding needs a deployed workflow, which needs Early Access `[REPORTED]` |

## Measured trust findings

- **`MockKeystoneForwarder` delivers forged reports from any sender.** `contracts/test/fork/MockForwarder.fork.t.sol` sends a report from an arbitrary address with no signatures, and the mainnet mock delivers it. It was run against mainnet. The Sepolia mock is assumed to behave the same way and is not yet measured. A vault using the mock can be emptied by anyone who writes a report whose arithmetic is consistent, so it must only ever hold test tokens.
- **The vault re-derives arithmetic, not facts.** It cannot see mainnet. It trusts the report for `user`, `C`, `X`, the band, the bonus, the verdict and the finality of the liquidation. Strict equality proves the redress follows from the reported fields, not that the fields are true. In production that trust rests on CRE consensus.
