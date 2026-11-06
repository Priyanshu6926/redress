#!/usr/bin/env bash
set -euo pipefail

# Deploys the vault on the local fork and funds it with real WETH wrapped from an Anvil
# account. Nothing here touches a public network. The key is Anvil's well-known first
# development key, which holds value only on local forks.
cd "$(dirname "$0")/.."
RPC=http://127.0.0.1:8545
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
MOCK_FORWARDER=0xa3d1ad4ac559a6575a114998affb2fb2ec97a7d9
RESERVE=3000ether

cd contracts
VERIFY_CLEARED=true CRE_FORWARDER=$MOCK_FORWARDER PAYOUT_ASSET=$WETH \
  forge script script/DeployVault.s.sol --rpc-url $RPC --private-key $KEY --broadcast --silent
VAULT=$(python -c "import json;print(json.load(open('broadcast/DeployVault.s.sol/1/run-latest.json'))['transactions'][0]['contractAddress'])")
cd ..

cast send $WETH 'deposit()' --value $RESERVE --rpc-url $RPC --private-key $KEY >/dev/null
cast send $WETH 'approve(address,uint256)' "$VAULT" $RESERVE --rpc-url $RPC --private-key $KEY >/dev/null
cast send "$VAULT" 'fund(uint256)' $RESERVE --rpc-url $RPC --private-key $KEY >/dev/null

mkdir -p deployments
printf '{\n  "network": "fork",\n  "vault": "%s",\n  "payoutAsset": "%s",\n  "forwarder": "%s",\n  "reserve": "%s"\n}\n' \
  "$VAULT" "$WETH" "$MOCK_FORWARDER" "$RESERVE" > deployments/fork.json
bun replay/gen-cre-config.ts fork
echo "vault $VAULT funded with $RESERVE"
