#!/usr/bin/env bash
set -euo pipefail

# Spin up a local Anvil fork one block before the incident execution block.
: "${MAINNET_RPC:?set MAINNET_RPC in .env}"
: "${INCIDENT_FORK_BLOCK:?set INCIDENT_FORK_BLOCK (execution block - 1, from replay/data/verification-report.txt)}"

echo "Starting Anvil fork at block ${INCIDENT_FORK_BLOCK}..."
anvil --fork-url "${MAINNET_RPC}" --fork-block-number "${INCIDENT_FORK_BLOCK}" --port 8545
