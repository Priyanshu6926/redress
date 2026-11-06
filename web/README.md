# Redress web

A plain black-and-white site served by `backend/api.ts`. It has no build step.

```bash
bun backend/api.ts   # then open http://localhost:3001
```

| Page | What it shows | Reads from |
|---|---|---|
| Overview | The incident, the six steps, and the comparison with the DAO | `replay.json` |
| Was I wronged? | Every verdict for an address | Arkiv, with `replay.json` as fallback |
| Replay | The incident block by block: oracle against band | `replay.json` |
| Explorer | Filters over all verdicts | Arkiv, with `replay.json` as fallback |
| Reserve | Bond and reserve shares, recovery claims, stress calculator | `mirror-sepolia.json` |
| Live | Recent real liquidations and the negative controls | `live.json`, `controls.json` |

Each lookup and explorer result says whether Arkiv or the fallback served it.
