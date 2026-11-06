/**
 * Rehearsal, not a CRE run. Delivers the TypeScript-encoded incident reports through the real
 * MockKeystoneForwarder bytecode into the vault on a local fork, then checks every victim's
 * real WETH balance. It proves the forwarder-to-vault-to-token path, not the workflow, so its
 * output is never used as a vault transaction in replay.json.
 *
 * Needs a fork on 127.0.0.1:8545 and deployments/fork.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { concatHex, createPublicClient, createWalletClient, decodeAbiParameters, http, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { REPORT_PARAMS } from "../cre/sentinel-verdict/report";

const RPC = "http://127.0.0.1:8545";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public development key
const HEADER_LENGTH = 109;

const root = join(import.meta.dir, "..");
const deployment = JSON.parse(readFileSync(join(root, "deployments", "fork.json"), "utf8")) as { vault: Address; payoutAsset: Address; forwarder: Address };
const fixture = JSON.parse(readFileSync(join(root, "contracts", "test", "report-fixture.json"), "utf8")) as { config: string; totalRedress: string; reports: { report: Hex; redress: string }[] };

const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const vaultAbi = parseAbi(["function totalPaid() view returns (uint256)", "function available() view returns (uint256)"]);

const transport = http(RPC);
const reader = createPublicClient({ chain: mainnet, transport });
const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), chain: mainnet, transport });

/** The mock tracks execution ids, so each delivery needs its own. */
const rawReport = (report: Hex, id: number) => concatHex([pad(toHex(id), { size: 33 }), pad("0x", { size: HEADER_LENGTH - 33 }), report]);
const deliver = async (report: Hex, id: number) => {
  const hash = await wallet.writeContract({ address: deployment.forwarder, abi: forwarderAbi, functionName: "report", args: [deployment.vault, rawReport(report, id), "0x", []] });
  return reader.waitForTransactionReceipt({ hash });
};
const balance = (user: Address) => reader.readContract({ address: deployment.payoutAsset, abi: tokenAbi, functionName: "balanceOf", args: [user] });
const paid = () => reader.readContract({ address: deployment.vault, abi: vaultAbi, functionName: "totalPaid" });

const expected = new Map<Address, bigint>();
for (const r of fixture.reports) {
  const [v] = decodeAbiParameters(REPORT_PARAMS, r.report);
  expected.set(v.user, (expected.get(v.user) ?? 0n) + BigInt(r.redress));
}
const before = new Map<Address, bigint>();
for (const user of expected.keys()) before.set(user, await balance(user));

const startPaid = await paid();
let id = 1;
for (const r of fixture.reports) await deliver(r.report, id++);
const afterPaid = await paid();

let wrong = 0;
for (const [user, want] of expected) {
  const got = (await balance(user)) - before.get(user)!;
  if (got !== want) {
    wrong++;
    console.log(`MISMATCH ${user}: expected ${want}, received ${got}`);
  }
}

// The same report again, under a new execution id, must not pay twice.
await deliver(fixture.reports[0]!.report, id++);
const afterDuplicate = await paid();

const summary = {
  rehearsal: true,
  note: "Reports delivered directly through MockKeystoneForwarder. CRE did not run. Not a mirror result.",
  config: fixture.config,
  reports: fixture.reports.length,
  recipients: expected.size,
  expectedWei: fixture.totalRedress,
  paidWei: (afterPaid - startPaid).toString(),
  recipientsWithWrongBalance: wrong,
  duplicateChangedTotal: afterDuplicate !== afterPaid,
  reserveLeftWei: (await reader.readContract({ address: deployment.vault, abi: vaultAbi, functionName: "available" })).toString(),
};
writeFileSync(join(root, "replay", "out", "rehearsal-fork.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(summary);
if (wrong || summary.paidWei !== fixture.totalRedress || summary.duplicateChangedTotal) process.exit(1);
