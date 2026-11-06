#!/usr/bin/env bash
set -euo pipefail

# Deploys the bond and ledger on Sepolia against the existing vault, verifies them on
# Etherscan and adds them to deployments/sepolia.json. Testnet only.
cd "$(dirname "$0")/.."
set -a; . <(tr -d '\r' < .env); set +a
: "${SEPOLIA_RPC:?set SEPOLIA_RPC in .env}"
: "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in .env}"

RPC=$SEPOLIA_RPC
[ "$(cast chain-id --rpc-url "$RPC")" = 11155111 ] || { echo "refusing to deploy: not Sepolia"; exit 1; }

read_field() { python -c "import json,sys;print(json.load(open('deployments/sepolia.json')).get(sys.argv[1],''))" "$1"; }
export VAULT; VAULT=$(read_field vault)
export PAYOUT_ASSET; PAYOUT_ASSET=$(read_field payoutAsset)

redact() { sed -e "s|$RPC|[redacted]|g" -e "s|$CRE_ETH_PRIVATE_KEY|[redacted]|g" -e "s|${ETHERSCAN_API_KEY:-no-etherscan-key}|[redacted]|g"; }
# Forge's simulated gas is far below Sepolia's schedule (VERIFY.md). Forge also defaults to a
# 1 gwei price, about 50 million times the current base fee.
broadcast() {
  (cd contracts && forge script "$1" --rpc-url "$RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --broadcast --silent \
    --slow --gas-estimate-multiplier 1000 --with-gas-price 2000 --priority-gas-price 100 "${@:2}") 2>&1 | redact
}

if [ -z "$(read_field operatorBond)" ]; then
  broadcast script/DeployAccountability.s.sol --verify --etherscan-api-key "${ETHERSCAN_API_KEY:-}"
fi
python - <<'PY'
import json
path = "deployments/sepolia.json"
d = json.load(open(path))
run = json.load(open("contracts/broadcast/DeployAccountability.s.sol/11155111/run-latest.json"))
for t in run["transactions"]:
    if t["transactionType"] == "CREATE":
        d[{"OperatorBond": "operatorBond", "RecoveryLedger": "recoveryLedger"}[t["contractName"]]] = t["contractAddress"]
json.dump(d, open(path, "w"), indent=2)
PY

for name in operatorBond recoveryLedger; do
  [ "$(cast code "$(read_field $name)" --rpc-url "$RPC")" != 0x ] || { echo "$name has no code"; exit 1; }
done
echo "deployed: bond $(read_field operatorBond), ledger $(read_field recoveryLedger)"
