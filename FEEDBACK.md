# Uniswap Developer Feedback

> **Submission Requirement**: Submitted to the Uniswap Developer Feedback Form (`https://developers.uniswap.org/hackathon-feedback`) with the repository link and this file reference.

---

## 1. What Worked
- **v4 Hooks Architecture**: Clean lifecycle hooks allowing native TWAP band verification (`BandOracleHook.sol`).
- **Tooling & SDKs**: Uniswap v4 periphery and v3 core SDK libraries provided clear contract interfaces and math helpers.

## 2. What Blocked Us
- **v4 Hook Address Mining**: Determining flags and mining deterministic prefix/suffix salt requires non-trivial compute overhead during test setups.
- **Documentation Gaps**: More end-to-end examples of custom oracle hooks with multi-pool or multi-tick range validation.

## 3. Missing Documentation & Resources
- Deep dives on combining v4 hooks with off-chain consensus networks (e.g., Chainlink CRE).
- Clearer testing recipes for Foundry hook deployment across mock pool managers and fork environments.

## 4. The One Highest-Impact Fix
- First-class Foundry test harness utilities for automated hook address mining in local integration test scripts.

