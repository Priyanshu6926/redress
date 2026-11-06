#!/usr/bin/env bash
set -euo pipefail

# Starts Anvil on a fork of mainnet taken after the incident, so the original liquidation
# transactions and their receipts exist. This is log replay (PRD 8.3): the workflow reads
# historical state at each liquidation's block, and only the vault runs on the fork.
cd "$(dirname "$0")/.."
# A .env saved on Windows has CRLF endings, and a trailing CR would corrupt every value.
set -a; . <(tr -d '\r' < .env); set +a
FORK_RPC="${FORK_RPC:-${MAINNET_RPC:?set MAINNET_RPC in .env}}"
REPLAY_FORK_BLOCK="${REPLAY_FORK_BLOCK:-26355926}"

echo "Starting Anvil fork at block ${REPLAY_FORK_BLOCK}"
exec anvil --fork-url "${FORK_RPC}" --fork-block-number "${REPLAY_FORK_BLOCK}" --port 8545 --silent
