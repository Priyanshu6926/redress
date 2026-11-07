import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, type Hex } from "viem";
import { REPORT_PARAMS } from "../../cre/sentinel-verdict/report";
import fixture from "../../contracts/test/report-fixture.json";
import incident from "../../replay/data/incident-reads.json";
import offchainFile from "../../replay/data/offchain-prices.json";
import mirror from "../../replay/out/mirror-sepolia.json";
import results from "../../replay/out/results-default.json";
import type { EventFacts } from "../../cre/sentinel-verdict/position";
import { VerdictType, WAD } from "../../cre/sentinel-verdict/verdict";
import { PRESETS, SIM_ADAPTER, parseWad, presetScenario, review, runIncident, settle, simulate, type IncidentRead } from "./scenario";
import { VaultRevert, VaultSim, deriveRedress, type VaultReport } from "./vault-sim";
import { call, decodePosition, judge } from "./live-entry";

const ADAPTER = mirror.rows[0]!.oracleAdapter;

function toReport(hex: Hex): VaultReport {
  const [v] = decodeAbiParameters(REPORT_PARAMS, hex);
  return { ...v, liquidationTx: v.liquidationTx, verdict: Number(v.verdict) } as unknown as VaultReport;
}

function realVault() {
  const vault = new VaultSim();
  vault.fund(parseWad("3000"));
  vault.depositBond(ADAPTER, parseWad("100"));
  return vault;
}

function simVault(bond = "100") {
  const vault = new VaultSim();
  vault.fund(parseWad("3000"));
  vault.depositBond(SIM_ADAPTER, parseWad(bond));
  return vault;
}

describe("scenario presets, through the real engine", () => {
  for (const preset of PRESETS) {
    test(`${preset.label} gives ${preset.expected}`, () => {
      const sim = simulate(presetScenario(preset.id));
      expect(sim.liquidated).toBe(true);
      expect(sim.result!.verdict).toBe(preset.expected);
    });
  }

  test("only the preset that should pay in full is WRONGFUL, and the others pay as designed", () => {
    const paid = (id: (typeof PRESETS)[number]["id"]) => simulate(presetScenario(id)).result!.assessment.redress;
    expect(paid("glitch")).toBeGreaterThan(0n);
    expect(paid("boundary")).toBeGreaterThan(0n);
    expect(paid("boundary")).toBeLessThan(paid("glitch"));
    for (const id of ["crash", "overprice", "outage", "manipulated"] as const) expect(paid(id)).toBe(0n);
  });

  test("a healthy position at the oracle price is not liquidated", () => {
    const sim = simulate(presetScenario("glitch", 50n));
    expect(sim.liquidated).toBe(false);
    expect(sim.result).toBeNull();
  });

  test("the glitch redress follows the spec's formula from the band", () => {
    const { result, seized, debtCovered } = simulate(presetScenario("glitch"));
    const low = result!.report.bandLowE18;
    expect(result!.assessment.redress).toBe((seized * low) / WAD - debtCovered);
  });

  test("the manipulated source is rejected and blocks the payout", () => {
    const r = simulate(presetScenario("manipulated")).result!;
    expect(r.assessment.redress).toBe(0n);
  });

  test("more severity seizes more collateral and owes more", () => {
    const at = (bps: bigint) => simulate(presetScenario("glitch", bps)).result!.assessment.redress;
    expect(at(400n)).toBeGreaterThan(at(285n));
  });

  test("parseWad is exact, and rejects anything else", () => {
    expect(parseWad("1.228849")).toBe(1228849000000000000n);
    expect(() => parseWad("-1")).toThrow(RangeError);
    expect(() => parseWad("1e3")).toThrow(RangeError);
  });
});

describe("the same call on a real incident event", () => {
  const facts = incident[0] as unknown as EventFacts;
  const row = results.incident.find((x) => x.txHash === (incident[0] as { txHash: string }).txHash)!;

  test("review() reaches the audited replay's verdict and redress", () => {
    const r = review(facts, offchainFile.prices, { label: "real", synthetic: false, tx: row.txHash, user: row.user, liquidator: "0x", builder: "0x", adapter: ADAPTER });
    expect(r.verdict).toBe(row.verdict as never);
    expect(r.assessment.redress.toString()).toBe(row.redress);
    expect(r.evidence).toBeDefined();
  });
});

describe("the real-incident button", () => {
  const run = runIncident(incident as unknown as IncidentRead[], offchainFile.prices, parseWad("3000"), parseWad("100"));

  test("gives the same verdict and wei as replay.json on every row", () => {
    for (const row of run.rows) {
      const want = results.incident.find((x) => x.txHash === row.tx && x.logIndex === row.logIndex)!;
      expect(row.verdict).toBe(want.verdict);
      expect(row.redress.toString()).toBe(want.redress);
    }
  });

  test("totals the amount actually paid on Sepolia", () => {
    expect(run.total).toBe(473295500496135010048n);
    expect(run.fromBond).toBe(parseWad("100"));
    expect(run.claims).toBe(47);
  });
});

describe("settle, as the page uses it", () => {
  const s = presetScenario("glitch");
  const report = simulate(s).result!.report;

  test("an honest report pays, and the replay is rejected", () => {
    const r = settle(s.reserve, s.bond, report, false);
    expect(r.payout!.fromBond).toBe(report.redress);
    expect(r.bondAfter).toBe(s.bond - report.redress);
    expect(r.reserveAfter).toBe(s.reserve);
    expect(r.replayRevert).toBe("AlreadyProcessed");
  });

  test("a tampered report reverts and moves nothing", () => {
    const r = settle(s.reserve, s.bond, report, true);
    expect(r.revert!.name).toBe("RedressMismatch");
    expect(r.payout).toBeNull();
    expect(r.bondAfter).toBe(s.bond);
    expect(r.reserveAfter).toBe(s.reserve);
  });

  test("the vault's re-derivation equals the engine's redress", () => {
    const r = simulate(s).result!;
    expect(r.rederived).toBe(r.assessment.redress);
  });

  test("the floor is below the midpoint, and below the net loss", () => {
    const sim = simulate(s);
    expect(sim.result!.assessment.redress).toBeLessThan(sim.result!.midpointLoss);
    expect(sim.result!.assessment.redress).toBeLessThanOrEqual(sim.netLoss);
  });

  test("the manipulated source is the one marked rejected", () => {
    const r = simulate(presetScenario("manipulated")).result!;
    expect(r.sources.filter((x) => !x.used).map((x) => x.source.name)).toEqual(["S3 off-chain"]);
  });
});

describe("vault rules against the real Sepolia run", () => {
  const reports = fixture.reports.map((r) => toReport(r.report as Hex));

  test("all 47 reports re-derive to the wei", () => {
    for (const r of reports) expect(deriveRedress(r)).toBe(r.redress);
  });

  test("every bond and reserve share matches the real mirror", () => {
    const vault = realVault();
    for (const r of reports) {
      const paid = vault.onReport(r);
      const real = mirror.rows.find((m) => m.liquidationTx.toLowerCase() === r.liquidationTx.toLowerCase() && m.logIndex === r.logIndex)!;
      expect(paid.fromBond.toString()).toBe(real.fromBond);
      expect(paid.fromReserve.toString()).toBe(real.fromReserve);
    }
    expect(vault.totalPaid).toBe(373295500496135010048n);
    expect(vault.totalPaidFromBond).toBe(100000000000000000000n);
    expect(vault.claims.size).toBe(47);
  });

  test("three named rows: the largest, the AMBIGUOUS one and the smallest", () => {
    const sorted = [...mirror.rows].sort((a, b) => (BigInt(a.redress) < BigInt(b.redress) ? 1 : -1));
    const picks = [sorted[0]!, mirror.rows.find((m) => m.verdict === "AMBIGUOUS")!, sorted[sorted.length - 1]!];
    for (const m of picks) {
      const r = reports.find((x) => x.liquidationTx.toLowerCase() === m.liquidationTx.toLowerCase() && x.logIndex === m.logIndex)!;
      expect(deriveRedress(r).toString()).toBe(m.redress);
    }
  });
});

describe("the vault rejects what the contract rejects", () => {
  const report = () => simulate(presetScenario("glitch")).result!.report;

  test("one wei too much reverts RedressMismatch and pays nothing", () => {
    const vault = simVault();
    const r = report();
    let caught: unknown;
    try {
      vault.onReport({ ...r, redress: r.redress + 1n });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VaultRevert);
    expect((caught as VaultRevert).errorName).toBe("RedressMismatch");
    expect(vault.totalPaidFromBond).toBe(0n);
    expect(vault.claims.size).toBe(0);
  });

  test("one wei too little also reverts, and the honest report still pays after", () => {
    const vault = simVault();
    const r = report();
    expect(() => vault.onReport({ ...r, redress: r.redress - 1n })).toThrow(VaultRevert);
    expect(vault.onReport(r).fromBond).toBe(r.redress);
  });

  test("a duplicate reverts AlreadyProcessed", () => {
    const vault = simVault();
    vault.onReport(report());
    try {
      vault.onReport(report());
      throw new Error("should revert");
    } catch (e) {
      expect((e as VaultRevert).errorName).toBe("AlreadyProcessed");
    }
  });

  test("a bonus above the bound reverts", () => {
    expect(() => simVault().onReport({ ...report(), liquidationBonusBps: 2_001n })).toThrow(VaultRevert);
  });

  test("the bond pays first, then the reserve", () => {
    const r = report();
    const vault = simVault("1");
    const paid = vault.onReport(r);
    expect(paid.fromBond).toBe(parseWad("1"));
    expect(paid.fromReserve).toBe(r.redress - parseWad("1"));
  });

  test("a payout over the epoch budget queues whole and draws nothing", () => {
    const vault = new VaultSim();
    vault.fund(parseWad("1"));
    const paid = vault.onReport(report());
    expect(paid.queued).toBe(true);
    expect(paid.fromReserve).toBe(0n);
    expect(vault.claims.size).toBe(0);
  });

  test("no redress means no claim", () => {
    const r = simulate(presetScenario("crash")).result!.report;
    expect(simVault().onReport(r).claim).toBeNull();
  });
});

test("VerdictType stays the shared enum", () => expect(VerdictType.WRONGFUL).toBe(1));

describe("the live demo's report", () => {
  const A = "0x0000000000000000000000000000000000000abc" as const;
  const seized = 31000000000000000n, repaid = 36700000000000000n;
  const facts = {
    tx: `0x${"ab".repeat(32)}` as const, logIndex: 3, blockNumber: 10n, user: A, liquidator: A, builder: A, adapter: A, debtAsset: A,
    oracle: parseWad("1.193826"), collateral: 63800000000000000n, debt: 73400000000000000n, seized, repaid,
  };

  test("a glitched oracle gives WRONGFUL through the real engine", () => {
    const j = judge(facts, A, 1n);
    expect(j.review.verdict).toBe("WRONGFUL");
    expect(j.review.assessment.redress).toBeGreaterThan(0n);
  });

  test("an oracle at the true price gives no payout", () => {
    const j = judge({ ...facts, oracle: parseWad("1.228849") }, A, 1n);
    expect(j.review.verdict).toBe("VALID");
    expect(j.review.assessment.redress).toBe(0n);
  });

  test("the encoded call differs per execution, so the mock forwarder accepts each one", () => {
    expect(judge(facts, A, 1n).data).not.toBe(judge(facts, A, 2n).data);
  });

  test("calls and position reads encode and decode", () => {
    expect(call.close(1n).startsWith("0x")).toBe(true);
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const p = decodePosition(`0x${word(BigInt(A))}${word(5n)}${word(6n)}${word(7n)}${word(1n)}`);
    expect(p.collateral).toBe(5n);
    expect(p.closed).toBe(true);
  });
});
