#!/usr/bin/env bash
set -euo pipefail

# Deploys the live demo on Sepolia and writes deployments/live.json. It uses real test ETH.
cd "$(dirname "$0")/.."
set -a; . <(tr -d '\r' < .env); set +a
: "${SEPOLIA_RPC:?set SEPOLIA_RPC in .env}"
: "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in .env}"
[ "$(cast chain-id --rpc-url "$SEPOLIA_RPC")" = 11155111 ] || { echo "refusing to deploy: not Sepolia"; exit 1; }

export CRE_FORWARDER=0x15fC6ae953E024d975e77382eEeC56A9101f9F88
export RESERVE_WEI="${RESERVE_WEI:-12000000000000000}"
export BOND_WEI="${BOND_WEI:-12000000000000000}"

(cd contracts && forge script script/DeployLive.s.sol --rpc-url "$SEPOLIA_RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --broadcast --silent \
  --slow --gas-estimate-multiplier 1000 --with-gas-price 2000 --priority-gas-price 100 \
  --verify --etherscan-api-key "${ETHERSCAN_API_KEY:-}") 2>&1 \
  | sed -e "s|$SEPOLIA_RPC|[redacted]|g" -e "s|$CRE_ETH_PRIVATE_KEY|[redacted]|g" -e "s|${ETHERSCAN_API_KEY:-no-etherscan-key}|[redacted]|g"

python - "$CRE_FORWARDER" <<'PY'
import json, sys
run = json.load(open("contracts/broadcast/DeployLive.s.sol/11155111/run-latest.json"))
c = {t["contractName"]: t["contractAddress"] for t in run["transactions"] if t["transactionType"] == "CREATE"}
json.dump({
    "network": "sepolia", "chainId": 11155111, "forwarder": sys.argv[1], "forwarderKind": "MockKeystoneForwarder",
    "weth": c["DemoWETH"], "pool": c["DemoLendingPool"], "bond": c["OperatorBond"], "ledger": c["RecoveryLedger"], "vault": c["RedressVault"],
}, open("deployments/live.json", "w"), indent=2)
PY
V=$(python -c "import json;print(json.load(open('deployments/live.json'))['vault'])")
[ "$(cast code "$V" --rpc-url "$SEPOLIA_RPC")" != 0x ] || { echo "vault has no code"; exit 1; }
echo "live demo deployed, vault $V, reserve $(cast call "$V" 'available()(uint256)' --rpc-url "$SEPOLIA_RPC" | cut -d' ' -f1)"
