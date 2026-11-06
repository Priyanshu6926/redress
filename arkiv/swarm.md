# Swarm

**Not built.** Swarm needs a postage batch ID and a Bee endpoint, and we do not have either. Nothing here should be read as a Swarm integration.

## What exists

- Each verdict has a real `evidenceHash`, the keccak256 of a deterministic evidence bundle, stored on-chain in the vault. See `evidenceBundle` in [`cre/sentinel-verdict/position.ts`](../cre/sentinel-verdict/position.ts).
- The Arkiv `verdict` entity has an `evidenceBzz` attribute, and it is empty.

## What would finish it

With a batch ID and a Bee endpoint: upload each bundle, check its keccak256 against the vault's `evidenceHash`, and write the reference into `evidenceBzz`.
