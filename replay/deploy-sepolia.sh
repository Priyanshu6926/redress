#!/usr/bin/env bash
set -euo pipefail

# Deploys test WETH and the vault on Sepolia, verifies them on Etherscan and writes
# deployments/sepolia.json. REHEARSAL=1 targets a local chain with Sepolia's chain id:
# no Etherscan, and it writes deployments/rehearsal.json instead.
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

SEPOLIA_MOCK_FORWARDER=0x15fC6ae953E024d975e77382eEeC56A9101f9F88
OUT=deployments/sepolia.json
VERIFY_ARGS=(--verify --etherscan-api-key "${ETHERSCAN_API_KEY:-}")

if [ "${REHEARSAL:-0}" = 1 ]; then
  RPC=http://127.0.0.1:8545
  KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # Anvil development key
  OUT=deployments/rehearsal.json
  VERIFY_ARGS=()
  export VERIFY_CLEARED=true
else
  : "${SEPOLIA_RPC:?set SEPOLIA_RPC in .env}"
  : "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in .env}"
  : "${VERIFY_CLEARED:?VERIFY.md has open deployment items}"
  RPC=$SEPOLIA_RPC
  KEY=$CRE_ETH_PRIVATE_KEY
fi

CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = 11155111 ] || { echo "refusing to deploy: chain id is $CHAIN, not Sepolia"; exit 1; }

export CRE_FORWARDER=$SEPOLIA_MOCK_FORWARDER
(cd contracts && forge script script/DeploySepolia.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast --silent \
  ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}) 2>&1 | sed "s|$RPC|[redacted]|g"

python - "$OUT" "$CRE_FORWARDER" <<'PY'
import json, os, sys
out, forwarder = sys.argv[1], sys.argv[2]
run = json.load(open("contracts/broadcast/DeploySepolia.s.sol/11155111/run-latest.json"))
created = {t["contractName"]: t for t in run["transactions"] if t["transactionType"] == "CREATE"}
os.makedirs("deployments", exist_ok=True)
json.dump({
    "network": "sepolia",
    "chainId": 11155111,
    "vault": created["RedressVault"]["contractAddress"],
    "vaultDeployTx": created["RedressVault"]["hash"],
    "payoutAsset": created["MockWETH"]["contractAddress"],
    "payoutAssetDeployTx": created["MockWETH"]["hash"],
    "forwarder": forwarder,
    "forwarderKind": "MockKeystoneForwarder",
}, open(out, "w"), indent=2)
PY
echo "wrote $OUT"
[ "${REHEARSAL:-0}" = 1 ] || bun replay/gen-cre-config.ts sepolia
