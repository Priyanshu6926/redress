/**
 * Arkiv Client: publishes and queries verdict and incident entities on the Arkiv network.
 */
export async function writeVerdictToArkiv(verdictData: Record<string, unknown>) {
  console.log("Writing verdict to Arkiv ledger...", verdictData);
}

export async function queryVerdictsByUser(userAddress: string) {
  console.log("Querying Arkiv verdicts for user:", userAddress);
  return [];
}

