/**
 * Builds replay/data/incident-2026-03-10.json from chain data (PRD 8.1).
 * Every wstETH-collateral liquidation in the scan window is stored. Nothing is
 * filtered to reach an expected total.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTION_TX, SCAN_AFTER, SCAN_BEFORE, SUBMISSION_TX, WETH, WSTETH, collectLiquidations, makeClient, resolveMarkets, safeMessage } from "./onchain";

export async function fetchIncidentData() {
  const c = makeClient();
  const exec = await c.getTransactionReceipt({ hash: EXECUTION_TX });
  const submission = await c.getTransactionReceipt({ hash: SUBMISSION_TX });
  const markets = await resolveMarkets(c, exec.blockNumber);
  const from = exec.blockNumber - SCAN_BEFORE;
  const to = exec.blockNumber + SCAN_AFTER;
  const liquidations = await collectLiquidations(c, markets, from, to, exec.blockNumber - 1n);

  const data = {
    incidentId: "aave-2026-03-10",
    protocol: "aave-v3",
    chain: "ethereum-mainnet",
    submissionTx: SUBMISSION_TX,
    submissionBlock: Number(submission.blockNumber),
    executionTx: EXECUTION_TX,
    executionBlock: Number(exec.blockNumber),
    executionTxIndex: exec.transactionIndex,
    scanFromBlock: Number(from),
    scanToBlock: Number(to),
    collateralAsset: WSTETH,
    debtAsset: WETH,
    markets,
    liquidations,
  };
  const path = join(import.meta.dir, "data", "incident-2026-03-10.json");
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${liquidations.length} liquidations to ${path}`);
}

if (import.meta.main) {
  fetchIncidentData().catch((e) => {
    console.error(`error: ${safeMessage(e)}`);
    process.exit(1);
  });
}
