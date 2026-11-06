# Replay targets (PRD 8.3). Each one is a thin wrapper, so it also runs without make:
# the command after the tab works directly, for example on Windows.
.PHONY: fork-up deploy-fork replay deploy-sepolia mirror scorecard snapshot

fork-up:
	bash replay/fork-up.sh

deploy-fork:
	bash replay/fork-deploy.sh

snapshot:
	bun replay/serve-snapshot.ts

replay:
	bun replay/mirror.ts fork

deploy-sepolia:
	bash replay/deploy-sepolia.sh

mirror:
	bun replay/mirror.ts sepolia

scorecard:
	bun replay/scorecard.ts
