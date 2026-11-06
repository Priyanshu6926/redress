#!/usr/bin/env bash
set -euo pipefail

# Deploys BandOracleHook on Sepolia, opens the synthetic demo pool, swaps so the band has data,
# verifies the hook and records it in deployments/sepolia.json. Testnet only.
cd "$(dirname "$0")/.."
set -a; . <(tr -d '\r' < .env); set +a
: "${SEPOLIA_RPC:?set SEPOLIA_RPC in .env}"
: "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in .env}"
RPC=$SEPOLIA_RPC
[ "$(cast chain-id --rpc-url "$RPC")" = 11155111 ] || { echo "refusing to deploy: not Sepolia"; exit 1; }

read_field() { python -c "import json,sys;print(json.load(open('deployments/sepolia.json')).get(sys.argv[1],''))" "$1"; }
export PAYOUT_ASSET DEMO_TOKEN
PAYOUT_ASSET=$(read_field payoutAsset)
DEMO_TOKEN=$(read_field hookPoolOtherToken)

redact() { sed -e "s|$RPC|[redacted]|g" -e "s|$CRE_ETH_PRIVATE_KEY|[redacted]|g" -e "s|${ETHERSCAN_API_KEY:-no-etherscan-key}|[redacted]|g"; }
# Forge's simulated gas is far below Sepolia's schedule, and its default price is 1 gwei (VERIFY.md).
broadcast() {
  (cd contracts && forge script "$1" --rpc-url "$RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --broadcast --silent \
    --slow --gas-estimate-multiplier 1000 --with-gas-price 2000 --priority-gas-price 100 "${@:2}") 2>&1 | redact
}

broadcast script/DeployHook.s.sol --verify --etherscan-api-key "${ETHERSCAN_API_KEY:-}"

python - <<'PY'
import json
path = "deployments/sepolia.json"
d = json.load(open(path))
run = json.load(open("contracts/broadcast/DeployHook.s.sol/11155111/run-latest.json"))
hook = next(t for t in run["transactions"] if t["contractName"] == "BandOracleHook")
if d.get("bandOracleHook") and d["bandOracleHook"].lower() != hook["contractAddress"].lower():
    d.setdefault("supersededHooks", []).append(d["bandOracleHook"])
d["bandOracleHook"] = hook["contractAddress"]
d["hookPool"] = {"token0": d["hookPoolOtherToken"], "token1": d["payoutAsset"], "fee": 3000, "tickSpacing": 60, "synthetic": True}
json.dump(d, open(path, "w"), indent=2)
PY

export TOKEN0 TOKEN1 HOOK
TOKEN0=$DEMO_TOKEN
TOKEN1=$PAYOUT_ASSET
HOOK=$(read_field bandOracleHook)
broadcast script/SwapHookPool.s.sol
[ "$(cast code "$HOOK" --rpc-url "$RPC")" != 0x ] || { echo "hook has no code"; exit 1; }
echo "hook $HOOK deployed, pool opened, swaps done"
