#!/usr/bin/env bash
set -euo pipefail

# Spin up local Anvil fork before the incident execution block
RPC_URL="${MAINNET_ARCHIVE_RPC_URL:-http://localhost:8545}"
FORK_BLOCK="${INCIDENT_FORK_BLOCK:-19405000}"

echo "Starting Anvil fork at block ${FORK_BLOCK}..."
anvil --fork-url "${RPC_URL}" --fork-block-number "${FORK_BLOCK}" --port 8545

