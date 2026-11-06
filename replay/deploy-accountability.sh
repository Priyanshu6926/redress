#!/usr/bin/env bash
set -euo pipefail

# Deploys the bond, ledger and hook on Sepolia against the existing vault, verifies them on
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
if [ -z "$(read_field bandOracleHook)" ]; then
  broadcast script/DeployHook.s.sol --verify --etherscan-api-key "${ETHERSCAN_API_KEY:-}"
fi

python - <<'PY'
import json
path = "deployments/sepolia.json"
d = json.load(open(path))
def created(script):
    run = json.load(open(f"contracts/broadcast/{script}/11155111/run-latest.json"))
    return [t for t in run["transactions"] if t["transactionType"] in ("CREATE", "CREATE2")]
for t in created("DeployAccountability.s.sol"):
    d[{"OperatorBond": "operatorBond", "RecoveryLedger": "recoveryLedger"}[t["contractName"]]] = t["contractAddress"]
for t in created("DeployHook.s.sol"):
    if t["contractName"] == "BandOracleHook":
        d["bandOracleHook"] = t["contractAddress"]
    elif t["contractName"] == "MockWETH":
        d["hookPoolOtherToken"] = t["contractAddress"]
a, b = sorted([d["payoutAsset"], d["hookPoolOtherToken"]], key=lambda x: int(x, 16))
d["hookPool"] = {"token0": a, "token1": b, "fee": 3000, "tickSpacing": 60}
d["uniswapPoolManager"] = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543"
json.dump(d, open(path, "w"), indent=2)
PY

export TOKEN0 TOKEN1 HOOK
TOKEN0=$(python -c "import json;print(json.load(open('deployments/sepolia.json'))['hookPool']['token0'])")
TOKEN1=$(python -c "import json;print(json.load(open('deployments/sepolia.json'))['hookPool']['token1'])")
HOOK=$(read_field bandOracleHook)
broadcast script/SwapHookPool.s.sol

for name in operatorBond recoveryLedger bandOracleHook; do
  [ "$(cast code "$(read_field $name)" --rpc-url "$RPC")" != 0x ] || { echo "$name has no code"; exit 1; }
done
echo "deployed: bond $(read_field operatorBond), ledger $(read_field recoveryLedger), hook $HOOK"
