import { VerdictType, computeRedress, type VerdictResult } from "./verdict";

export async function main() {
  console.log("Chainlink CRE Sentinel Verdict workflow triggered");
}

if (require.main === module) {
  main().catch(console.error);
}

