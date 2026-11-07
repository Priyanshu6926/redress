/**
 * Glitch Simulator scenarios. A scenario becomes the same EventFacts the CRE workflow reads from
 * chain, and goes through the same assess() call, so every figure is the real engine's output.
 * Money is bigint throughout. Text is parsed to bigint here and formatted only in the page.
 */
import { effectiveBonusBps } from "../../cre/sentinel-verdict/bonus";
import { assess, evidenceHash, toLiquidation, type Assessment, type EventFacts, type OffchainPrice } from "../../cre/sentinel-verdict/position";
import { BPS, DEFAULT_CONFIG, INCONCLUSIVE, VerdictType, WAD, gate, hfFloor, type EngineConfig, type Liquidation, type PriceSource } from "../../cre/sentinel-verdict/verdict";
import { VaultRevert, VaultSim, deriveRedress, type Payout, type VaultReport } from "./vault-sim";

export type PresetId = "glitch" | "crash" | "overprice" | "outage" | "boundary" | "manipulated";

export interface Scenario {
  preset: PresetId;
  severityBps: bigint;
  collateral: bigint;
  debt: bigint;
  truePrice: bigint;
  ltBps: bigint;
  bonusBps: bigint;
  closeFactorBps: bigint;
  /** Signed offsets from the true price, in basis points. */
  noiseBps: { lido: bigint; twap: bigint; offchain: bigint };
  manipulationBps: bigint;
  reserve: bigint;
  bond: bigint;
}

export const PRESETS: { id: PresetId; label: string; expected: keyof typeof VerdictType; note: string }[] = [
  { id: "glitch", label: "Oracle glitch (undervalue)", expected: "WRONGFUL", note: "The oracle falls alone. The sources disagree with it." },
  { id: "crash", label: "Real market crash", expected: "VALID", note: "All sources fall with the oracle, so the liquidation was justified." },
  { id: "overprice", label: "Oracle overprices", expected: "OVERPRICED", note: "The oracle is too high. This debt was unhealthy anyway, so nothing is owed." },
  { id: "outage", label: "Source outage", expected: "INCONCLUSIVE", note: "Only one source is live, which is too little evidence to judge." },
  { id: "boundary", label: "Boundary position", expected: "AMBIGUOUS", note: "The band straddles a health factor of 1, so only the provable excess is paid." },
  { id: "manipulated", label: "One source manipulated", expected: "INCONCLUSIVE", note: "Known limitation: one bad source leaves too few, and blocks a legitimate payout." },
];

const SIM_TX = `0x${"51".repeat(32)}`;
const SIM_TIME = 1_000_000;
const SIM_USER = "0x00000000000000000000000000000000000000a1";
export const SIM_LIQUIDATOR = "0x00000000000000000000000000000000000000b2";
export const SIM_BUILDER = "0x00000000000000000000000000000000000000c3";
export const SIM_ADAPTER = "0x00000000000000000000000000000000000000d4";
const SIM_COLLATERAL = "0x00000000000000000000000000000000000000e5";
const SIM_DEBT = "0x00000000000000000000000000000000000000f6";

/** Exact decimal text to 1e18 fixed point. */
export function parseWad(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) throw new RangeError(`not a positive decimal with up to 18 places: ${text}`);
  return BigInt(m[1]!) * WAD + BigInt((m[2] ?? "").padEnd(18, "0"));
}

export function defaultScenario(): Scenario {
  return {
    preset: "glitch",
    severityBps: 285n,
    collateral: parseWad("300"),
    debt: parseWad("345.16"),
    truePrice: parseWad("1.228849"),
    ltBps: 9_550n,
    bonusBps: 100n,
    closeFactorBps: 5_000n,
    noiseBps: { lido: 0n, twap: -3n, offchain: 2n },
    manipulationBps: 500n,
    reserve: parseWad("3000"),
    bond: parseWad("100"),
  };
}

/** A preset's starting values. Only the positions that need a different debt change it. */
export function presetScenario(preset: PresetId, severityBps = 285n): Scenario {
  const s = { ...defaultScenario(), preset, severityBps };
  if (preset === "overprice") s.debt = parseWad("390");
  if (preset === "boundary") s.debt = parseWad("351.9");
  return s;
}

const offset = (price: bigint, bps: bigint) => (price * (BPS + bps)) / BPS;

/** What the scenario does to the oracle and the independent sources. Pure. */
export function prices(s: Scenario) {
  const down = -s.severityBps;
  const market = s.preset === "crash" ? offset(s.truePrice, down) : s.truePrice;
  const oracle = s.preset === "overprice" ? offset(s.truePrice, s.severityBps) : offset(s.truePrice, down);
  return {
    oracle,
    market,
    lido: offset(market, s.noiseBps.lido),
    twap: s.preset === "outage" ? null : offset(market, s.noiseBps.twap),
    offchain: s.preset === "outage" ? null : offset(market, s.noiseBps.offchain + (s.preset === "manipulated" ? s.manipulationBps : 0n)),
  };
}

/** Aave's liquidation amounts at the oracle price, rounded down. Pure. */
export function liquidationAmounts(s: Scenario, oracle: bigint) {
  const debtCovered = (s.debt * s.closeFactorBps) / BPS;
  const seized = (debtCovered * WAD * (BPS + s.bonusBps)) / (oracle * BPS);
  return { debtCovered, seized: seized > s.collateral ? s.collateral : seized };
}

/** The chain facts a real event would give the workflow. */
export function factsFor(s: Scenario, oracle: bigint, market: bigint, lido: bigint, twap: bigint | null, debtCovered: bigint, seized: bigint): EventFacts {
  return {
    blockNumber: 1,
    logIndex: 0,
    timestamp: SIM_TIME,
    debtToCover: debtCovered.toString(),
    collateralEvent: seized.toString(),
    debtDecimals: 18,
    protocolFee: "0",
    lidoRate: lido.toString(),
    twapPrice: twap === null ? null : twap.toString(),
    oracleCollateral: oracle.toString(),
    oracleDebt: WAD.toString(),
    oracleWeth: WAD.toString(),
    preOracleCollateral: market.toString(),
    preOracleWeth: WAD.toString(),
    preCollateralBalance: s.collateral.toString(),
    preDebtBalance: s.debt.toString(),
    totalCollateralBase: "0",
    totalDebtBase: "0",
    ltBps: s.ltBps.toString(),
    bonusBps: effectiveBonusBps({ reserveConfig: 0n, eModeCategory: 1n, eModeBonus: BPS + s.bonusBps, collateralBitmap: 2n, reserveId: 1n }).toString(),
    borrows: 1,
    collaterals: 1,
  };
}

export interface Review {
  label: string;
  synthetic: boolean;
  facts: EventFacts;
  assessment: Assessment;
  verdict: keyof typeof VerdictType;
  gateOpen: boolean;
  sources: { source: PriceSource; devBps: bigint; used: boolean }[];
  median: bigint;
  /** Oracle distance outside the band, in basis points, and which side. */
  oracleGapBps: bigint;
  oracleSide: "below" | "above" | "inside";
  /** C · band midpoint − X. A point estimate, never paid. */
  midpointLoss: bigint;
  rederived: bigint;
  config: EngineConfig;
  evidence: string;
  report: VaultReport;
}

/** The engine call, shared by synthetic scenarios and the real incident event. */
export function review(facts: EventFacts, offchain: OffchainPrice[], ctx: { label: string; synthetic: boolean; tx: string; user: string; liquidator: string; builder: string; adapter: string; peers?: Liquidation[] }): Review {
  const config = DEFAULT_CONFIG;
  const assessment = assess(facts, ctx.peers ?? [], config, offchain);
  const { band, target, outcome } = assessment;
  const ok = band !== INCONCLUSIVE;

  // The display repeats buildBand's median and outlier rule, which it does not return.
  const sorted = assessment.sources.map((s) => s.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  const median = sorted.length === 0 ? 0n : sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const sources = assessment.sources.map((source) => ({
    source,
    devBps: median === 0n ? 0n : ((source.price - median) * BPS) / median,
    used: abs(source.price - median) * BPS <= config.epsOutBps * median,
  }));

  const oracle = target.oracleCollateralPrice;
  const low = ok ? band.collateral.low : 0n;
  const high = ok ? band.collateral.high : 0n;
  const oracleSide = !ok ? "inside" : oracle < low ? "below" : oracle > high ? "above" : "inside";
  const oracleGapBps = oracleSide === "below" ? ((low - oracle) * BPS) / low : oracleSide === "above" ? ((oracle - high) * BPS) / high : 0n;
  const midValue = (target.collateralSeized * ((low + high) / 2n)) / WAD;
  const debtValue = (target.debtCovered * assessment.debtPrice) / WAD;
  const midpointLoss = ok && midValue > debtValue ? midValue - debtValue : 0n;

  const evidence = evidenceHash({ txHash: ctx.tx, facts, chainlinkStEthEth: "0", sources: assessment.sources, peers: 0, config });
  return {
    label: ctx.label,
    synthetic: ctx.synthetic,
    facts,
    assessment,
    verdict: VerdictType[outcome.verdict] as keyof typeof VerdictType,
    gateOpen: ok && gate(target.oracleCollateralPrice, target.oracleDebtPrice, band, config.tauBps),
    sources,
    median,
    oracleGapBps,
    oracleSide,
    midpointLoss,
    rederived: 0n,
    config,
    evidence,
    report: {
      liquidationTx: ctx.tx,
      logIndex: facts.logIndex,
      user: ctx.user,
      debtToCover: target.debtCovered,
      collateralSeized: target.collateralSeized,
      bandLowE18: ok ? band.collateral.low : 0n,
      bandHighE18: ok ? band.collateral.high : 0n,
      debtPriceHighE18: assessment.debtPrice,
      liquidationBonusBps: BigInt(facts.bonusBps),
      verdict: outcome.verdict,
      redress: assessment.redress,
      evidenceHash: evidence,
      oracleAdapter: ctx.adapter,
      liquidator: ctx.liquidator,
      builder: ctx.builder,
    },
  };
}

/** Review plus the vault's own re-derivation of the amount. */
function reviewed(r: Review): Review {
  return { ...r, rederived: r.assessment.band === INCONCLUSIVE ? 0n : deriveRedress(r.report) };
}

export interface Settlement {
  reserveBefore: bigint;
  bondBefore: bigint;
  reserveAfter: bigint;
  bondAfter: bigint;
  payout: Payout | null;
  revert: { name: string; detail: string; checks: Payout["checks"] } | null;
  /** The same report sent twice, to show idempotency rejecting it. */
  replayRevert: string | null;
}

/** Sends a report through the simulated vault. Tampering adds one wei. */
export function settle(reserve: bigint, bond: bigint, report: VaultReport, tamper: boolean): Settlement {
  const vault = new VaultSim();
  vault.fund(reserve);
  vault.depositBond(report.oracleAdapter, bond);
  const sent = tamper ? { ...report, redress: report.redress + 1n } : report;
  const after = () => ({ reserveAfter: vault.available, bondAfter: vault.bonds.get(report.oracleAdapter) ?? 0n });
  try {
    const payout = vault.onReport(sent);
    let replayRevert: string | null = null;
    try {
      vault.onReport(sent);
    } catch (e) {
      replayRevert = (e as VaultRevert).errorName;
    }
    return { reserveBefore: reserve, bondBefore: bond, ...after(), payout, revert: null, replayRevert };
  } catch (e) {
    if (!(e instanceof VaultRevert)) throw e;
    return { reserveBefore: reserve, bondBefore: bond, ...after(), payout: null, revert: { name: e.errorName, detail: e.message, checks: e.checks }, replayRevert: null };
  }
}

export interface IncidentRead extends EventFacts {
  txHash: string;
  pool: string;
  user: string;
}

export interface IncidentRun {
  rows: { tx: string; logIndex: number; verdict: string; redress: bigint }[];
  total: bigint;
  fromBond: bigint;
  fromReserve: bigint;
  claims: number;
}

/** All real incident events through the same engine call and vault rules, in event order. */
export function runIncident(reads: IncidentRead[], offchain: OffchainPrice[], reserve: bigint, bond: bigint): IncidentRun {
  const ordered = [...reads].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const groupOf = (r: IncidentRead) => `${r.pool}:${r.user}`.toLowerCase();
  const vault = new VaultSim();
  vault.fund(reserve);
  vault.depositBond(SIM_ADAPTER, bond);

  const rows = ordered.map((r) => {
    const peers = ordered.filter((x) => groupOf(x) === groupOf(r)).map(toLiquidation);
    const result = review(r, offchain, { label: "real", synthetic: false, tx: r.txHash, user: r.user, liquidator: SIM_LIQUIDATOR, builder: SIM_BUILDER, adapter: SIM_ADAPTER, peers });
    vault.onReport(result.report);
    return { tx: r.txHash, logIndex: r.logIndex, verdict: result.verdict as string, redress: result.assessment.redress };
  });
  return { rows, total: vault.totalPaid + vault.totalPaidFromBond, fromBond: vault.totalPaidFromBond, fromReserve: vault.totalPaid, claims: vault.claims.size };
}

export interface Simulation {
  scenario: Scenario;
  oracle: bigint;
  market: bigint;
  hfTrue: bigint;
  hfOracle: bigint;
  /** False when the oracle move leaves the position healthy, so nothing happens. */
  liquidated: boolean;
  debtCovered: bigint;
  seized: bigint;
  /** Equity at the market price, before and after the liquidation. */
  equityBefore: bigint;
  equityAfter: bigint;
  /** Collateral seized at the market price, less debt relieved. */
  netLoss: bigint;
  result: Review | null;
}

export function simulate(s: Scenario): Simulation {
  const p = prices(s);
  const hfTrue = hfFloor(s.collateral, s.truePrice, s.debt, WAD, s.ltBps);
  const hfOracle = hfFloor(s.collateral, p.oracle, s.debt, WAD, s.ltBps);
  const { debtCovered, seized } = liquidationAmounts(s, p.oracle);
  const value = (a: bigint) => (a * p.market) / WAD;
  const base = { scenario: s, oracle: p.oracle, market: p.market, hfTrue, hfOracle, debtCovered, seized, equityBefore: value(s.collateral) - s.debt };
  if (hfOracle >= WAD) return { ...base, liquidated: false, equityAfter: base.equityBefore, netLoss: 0n, result: null };

  const facts = factsFor(s, p.oracle, p.market, p.lido, p.twap, debtCovered, seized);
  const offchain: OffchainPrice[] = p.offchain === null ? [] : [{ name: "off-chain", timestamp: SIM_TIME, price: p.offchain.toString() }];
  const label = PRESETS.find((x) => x.id === s.preset)!.label;
  const result = reviewed(review(facts, offchain, { label, synthetic: true, tx: SIM_TX, user: SIM_USER, liquidator: SIM_LIQUIDATOR, builder: SIM_BUILDER, adapter: SIM_ADAPTER }));
  const lost = value(seized) - debtCovered;
  return { ...base, liquidated: true, equityAfter: value(s.collateral - seized) - (s.debt - debtCovered), netLoss: lost > 0n ? lost : 0n, result };
}

export { SIM_COLLATERAL, SIM_DEBT };
