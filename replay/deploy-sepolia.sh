#!/usr/bin/env bash
set -euo pipefail

# Deploys test WETH and the vault on Sepolia, verifies them on Etherscan and writes
# deployments/sepolia.json. REHEARSAL=1 targets a local chain with Sepolia's chain id:
# no Etherscan, and it writes deployments/rehearsal.json instead.
cd "$(dirname "$0")/.."
# A .env saved on Windows has CRLF endings, and a trailing \r would corrupt every value.
set -a; . <(tr -d '\r' < .env); set +a

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
# Sepolia's gas schedule is not the one forge simulates: the node estimated 9,557,013 gas for
# the vault create against forge's 1,359,377, so the default 130% ran out of gas. 1000% clears
# that and stays under the 16,777,216 transaction cap. --slow stops at the first failure.
(cd contracts && forge script script/DeploySepolia.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast --silent \
  --slow --gas-estimate-multiplier 1000 \
  ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}) 2>&1 | sed -e "s|$RPC|[redacted]|g" -e "s|$KEY|[redacted]|g" -e "s|${ETHERSCAN_API_KEY:-no-etherscan-key}|[redacted]|g"

python - "$OUT" "$CRE_FORWARDER" <<'PY'
import json, os, sys
out, forwarder = sys.argv[1], sys.argv[2]
run = json.load(open("contracts/broadcast/DeploySepolia.s.sol/11155111/run-latest.json"))
created = {t["contractName"]: t["contractAddress"] for t in run["transactions"] if t["transactionType"] == "CREATE"}
# The hash on a transaction entry has been seen paired with the wrong call, so deploy hashes
# come from the receipt that created each address.
deploy_tx = {r["contractAddress"].lower(): r["transactionHash"] for r in run["receipts"] if r.get("contractAddress")}
os.makedirs("deployments", exist_ok=True)
json.dump({
    "network": "sepolia",
    "chainId": 11155111,
    "vault": created["RedressVault"],
    "vaultDeployTx": deploy_tx[created["RedressVault"].lower()],
    "payoutAsset": created["MockWETH"],
    "payoutAssetDeployTx": deploy_tx[created["MockWETH"].lower()],
    "forwarder": forwarder,
    "forwarderKind": "MockKeystoneForwarder",
}, open(out, "w"), indent=2)
PY

# A broadcast that reports success proves nothing until the chain agrees.
VAULT=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['vault'])" "$OUT")
WETH=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['payoutAsset'])" "$OUT")
RESERVE_HELD=$(cast call "$WETH" 'balanceOf(address)(uint256)' "$VAULT" --rpc-url "$RPC" | cut -d' ' -f1)
[ "$(cast code "$VAULT" --rpc-url "$RPC")" != 0x ] && [ "$RESERVE_HELD" = "${RESERVE_WEI:-3000000000000000000000}" ] || {
  rm -f "$OUT"; echo "deployment failed its on-chain check"; exit 1; }
echo "wrote $OUT"
[ "${REHEARSAL:-0}" = 1 ] || bun replay/gen-cre-config.ts sepolia
