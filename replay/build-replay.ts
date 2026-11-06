/**
 * Builds replay/out/replay.json (docs/replay.schema.json) from replay results, and the
 * clearly labelled replay/out/replay.mock.json for frontend work. buildReplay is pure.
 */
import { type Row } from "./evaluate";
import { fmt18 } from "./onchain";
import type { EventReads } from "./reads";
import type { Mirror } from "./mirror";
import type { Results } from "./replay";

export const DAO_HEADLINE = 512.19;
export const DAO_TABLE = 512.48;
export const EXPECTED_POSITIONS = 34;
const WAD = 10n ** 18n;

const CONTROL_NOTE =
  "50 calm-period wstETH liquidations; only some have WETH debt, and the rest use Aave's own debt price, so they test the collateral side only. Aave's oracle equalled the Lido rate on every control.";

const sum = (rows: Row[], f: (r: Row) => string) => rows.reduce((a, r) => a + BigInt(f(r)), 0n);
const eth = (v: bigint) => Number(fmt18(v, 6));
const pct = (got: number, want: number) => Number((((got - want) / want) * 100).toFixed(3));
const compare = (v: bigint) => {
  const value = eth(v);
  return { eth: value, vsDaoHeadlinePct: pct(value, DAO_HEADLINE), vsDaoTablePct: pct(value, DAO_TABLE) };
};

function tally(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.verdict] = (out[r.verdict] ?? 0) + 1;
  return out;
}

function configOf(r: Results) {
  const c = r.config;
  return {
    name: String(c.name),
    minSources: Number(c.minSources),
    tauBps: String(c.tauBps),
    muBps: String(c.muBps),
    epsOutBps: String(c.epsOutBps),
    epsHBps: String(c.epsHBps),
    maxStalenessSec: String(c.maxStalenessSec),
  };
}

function controlOf(r: Results) {
  const falsePositives = r.control.filter((x) => BigInt(x.redress) > 0n || (x.verdict !== "VALID" && x.verdict !== "INCONCLUSIVE"));
  return {
    events: r.control.length,
    verdicts: tally(r.control),
    falsePositives: falsePositives.length,
    totalRedressEth: eth(sum(r.control, (x) => x.redress)),
    wethDebtEvents: r.control.filter((x) => x.debtAsset.toLowerCase().startsWith("0xc02a")).length,
    note: CONTROL_NOTE,
  };
}

/** One point per block, starting from the block before the first liquidation. */
function seriesOf(rows: Row[], reads: EventReads[]) {
  const first = reads.reduce((a, b) => (b.blockNumber < a.blockNumber ? b : a));
  const oracle = (collateral: string, weth: string) => ((BigInt(collateral) * WAD) / BigInt(weth)).toString();
  const points = [{
    block: first.blockNumber - 1,
    timestamp: null as number | null,
    oraclePrice: oracle(first.preOracleCollateral, first.preOracleWeth),
    bandLow: null as string | null,
    bandHigh: null as string | null,
    liquidations: 0,
    cumulativeRedressFloor: "0",
  }];

  let cumulative = 0n;
  const blocks = [...new Set(reads.map((r) => r.blockNumber))].sort((a, b) => a - b);
  for (const block of blocks) {
    const inBlock = rows.filter((r) => r.block === block);
    const read = reads.find((r) => r.blockNumber === block)!;
    cumulative += sum(inBlock, (r) => r.redress);
    points.push({
      block,
      timestamp: read.timestamp,
      oraclePrice: oracle(read.oracleCollateral, read.oracleWeth),
      bandLow: inBlock[0]?.bandLow ?? null,
      bandHigh: inBlock[0]?.bandHigh ?? null,
      liquidations: inBlock.length,
      cumulativeRedressFloor: cumulative.toString(),
    });
  }
  return points;
}

export interface BuildInput {
  primary: Results;
  alternates: Results[];
  reads: EventReads[];
  incident: { executionTx: string; executionBlock: number; collateralAsset: string; debtAsset: string; markets: { name: string; pool: string }[] };
  mirror: Mirror | null;
  dataChecks: { singleAssetEvents: number; maxDeviationBpsSingle: number; multiAssetEvents: number; maxDeviationBpsMulti: number };
}

export function buildReplay({ primary, alternates, reads, incident, mirror, dataChecks }: BuildInput) {
  const rows = primary.incident;
  const vaultTxOf = new Map((mirror?.rows ?? []).map((m) => [`${m.liquidationTx}:${m.logIndex}`, m.vaultTx]));
  const positionKey = (r: Row) => `${r.market}:${r.user}`.toLowerCase();
  const verdictsByPosition = new Map<string, Set<string>>();
  for (const r of rows) verdictsByPosition.set(positionKey(r), (verdictsByPosition.get(positionKey(r)) ?? new Set()).add(r.verdict));
  const blocks = rows.map((r) => r.block);

  return {
    schemaVersion: "1.0.0",
    mock: false,
    config: configOf(primary),
    incident: {
      id: "aave-2026-03-10",
      protocol: "aave-v3",
      chain: "ethereum-mainnet",
      title: "Aave wstETH CAPO misconfiguration, 10 March 2026",
      executionTx: incident.executionTx,
      executionBlock: incident.executionBlock,
      firstLiquidationBlock: Math.min(...blocks),
      lastLiquidationBlock: Math.max(...blocks),
      collateralAsset: incident.collateralAsset,
      debtAsset: incident.debtAsset,
      markets: incident.markets.filter((m) => rows.some((r) => r.market === m.name)).map((m) => ({ name: m.name, pool: m.pool })),
    },
    series: seriesOf(rows, reads),
    liquidations: rows.map((r) => ({
      market: r.market,
      user: r.user,
      tx: r.txHash,
      logIndex: r.logIndex,
      block: r.block,
      debtToCover: r.debtToCover,
      collateralSeized: r.collateralSeized,
      verdict: r.verdict,
      hfWorst: r.hfWorst,
      bandLow: r.bandLow,
      bandHigh: r.bandHigh,
      sourcesUsed: r.sourcesUsed,
      sourcesRejected: r.sourcesRejected,
      redressFloor: r.redress,
      redressMidpoint: r.lossAtBandMid,
      vaultTx: vaultTxOf.get(`${r.txHash}:${r.logIndex}`) ?? null,
      evidenceHash: r.evidenceHash,
      multiAsset: r.multiAsset,
      bonusBps: r.bonusBps,
    })),
    scorecard: {
      events: rows.length,
      eventVerdicts: tally(rows),
      positions: verdictsByPosition.size,
      addresses: new Set(rows.map((r) => r.user.toLowerCase())).size,
      positionsAllWrongful: [...verdictsByPosition.values()].filter((v) => v.size === 1 && v.has("WRONGFUL")).length,
      expectedPositions: EXPECTED_POSITIONS,
      paidFloor: compare(sum(rows, (r) => r.redress)),
      comparisonMidpoint: compare(sum(rows, (r) => r.lossAtBandMid)),
      daoHeadlineEth: DAO_HEADLINE,
      daoTableEth: DAO_TABLE,
      payouts: {
        target: mirror?.target ?? null,
        network: mirror ? (mirror.target === "sepolia" ? "sepolia" : "local-fork") : null,
        vault: mirror?.vault ?? null,
        payoutAsset: mirror?.payoutAsset ?? null,
        complete: mirror?.complete ?? false,
        recorded: mirror?.rows.length ?? 0,
        totalPaidWei: mirror?.totalPaidWei ?? "0",
      },
    },
    control: controlOf(primary),
    alternateConfigs: alternates.map((r) => ({
      config: configOf(r),
      eventVerdicts: tally(r.incident),
      paidFloor: compare(sum(r.incident, (x) => x.redress)),
      comparisonMidpoint: compare(sum(r.incident, (x) => x.lossAtBandMid)),
      control: controlOf(r),
    })),
    dataChecks,
  };
}

/** Synthetic data covering every UI state. Addresses and hashes are obvious placeholders. */
export function buildMock() {
  const addr = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const hash = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`;
  const E18 = "000000000000000000";
  const row = (i: number, verdict: string, floor: string, midpoint: string, vaultTx: string | null, extra: object = {}) => ({
    market: i % 2 ? "Mock Market A" : "Mock Market B",
    user: addr(i),
    tx: hash(i),
    logIndex: i,
    block: 1000 + i,
    debtToCover: `100${E18}`,
    collateralSeized: `85${E18}`,
    verdict,
    hfWorst: verdict === "WRONGFUL" ? `102${E18.slice(1)}` : `99${E18.slice(1)}`,
    bandLow: `122${E18.slice(1)}`,
    bandHigh: `123${E18.slice(1)}`,
    sourcesUsed: ["S1 mock rate", "S2 mock TWAP", "S3 mock API"],
    sourcesRejected: [] as string[],
    redressFloor: floor,
    redressMidpoint: midpoint,
    vaultTx,
    evidenceHash: hash(i + 1),
    multiAsset: false,
    bonusBps: "100",
    ...extra,
  });
  const liquidations = [
    row(1, "WRONGFUL", `3${E18}`, `4${E18}`, hash(7)),
    row(1, "WRONGFUL", `2${E18}`, `2${E18}`, null, { logIndex: 20, block: 1002, tx: hash(2) }),
    row(3, "AMBIGUOUS", `1${E18.slice(1)}`, `2${E18.slice(1)}`, hash(8), { bonusBps: "600" }),
    row(4, "EXCESS", `5${E18.slice(1)}`, `6${E18.slice(1)}`, null, { multiAsset: true }),
    row(5, "VALID", "0", "0", null),
    row(6, "INCONCLUSIVE", "0", "0", null, { bandLow: "0", bandHigh: "0", sourcesUsed: [], sourcesRejected: ["S3 mock API"] }),
    row(9, "OVERPRICED", "0", "0", null),
  ];
  const comparison = (value: number) => ({ eth: value, vsDaoHeadlinePct: -50, vsDaoTablePct: -50 });
  const config = { name: "mock", minSources: 3, tauBps: "75", muBps: "10", epsOutBps: "100", epsHBps: "10", maxStalenessSec: "3600" };
  const control = { events: 2, verdicts: { VALID: 2 }, falsePositives: 0, totalRedressEth: 0, wethDebtEvents: 1, note: "Mock data." };
  return {
    schemaVersion: "1.0.0",
    mock: true,
    config,
    incident: {
      id: "mock-incident",
      protocol: "mock-protocol",
      chain: "mock-chain",
      title: "MOCK DATA: not a real incident",
      executionTx: hash(1),
      executionBlock: 1000,
      firstLiquidationBlock: 1001,
      lastLiquidationBlock: 1009,
      collateralAsset: addr(1),
      debtAsset: addr(2),
      markets: [{ name: "Mock Market A", pool: addr(3) }, { name: "Mock Market B", pool: addr(4) }],
    },
    series: [
      { block: 1000, timestamp: null, oraclePrice: `1228${E18.slice(3)}`, bandLow: null, bandHigh: null, liquidations: 0, cumulativeRedressFloor: "0" },
      { block: 1001, timestamp: 1700000000, oraclePrice: `1194${E18.slice(3)}`, bandLow: `1226${E18.slice(3)}`, bandHigh: `1230${E18.slice(3)}`, liquidations: 2, cumulativeRedressFloor: `3${E18}` },
      { block: 1002, timestamp: 1700000012, oraclePrice: `1194${E18.slice(3)}`, bandLow: `1226${E18.slice(3)}`, bandHigh: `1230${E18.slice(3)}`, liquidations: 1, cumulativeRedressFloor: `5${E18}` },
    ],
    liquidations,
    scorecard: {
      events: liquidations.length,
      eventVerdicts: { WRONGFUL: 2, AMBIGUOUS: 1, EXCESS: 1, VALID: 1, INCONCLUSIVE: 1, OVERPRICED: 1 },
      positions: 6,
      addresses: 6,
      positionsAllWrongful: 1,
      expectedPositions: 6,
      paidFloor: comparison(5.6),
      comparisonMidpoint: comparison(6.8),
      daoHeadlineEth: 11.2,
      daoTableEth: 11.2,
      payouts: { target: "mock", network: "mock", vault: addr(5), payoutAsset: addr(6), complete: false, recorded: 2, totalPaidWei: `3${E18}` },
    },
    control,
    alternateConfigs: [{ config: { ...config, name: "mock-alternate", minSources: 2 }, eventVerdicts: { WRONGFUL: 2 }, paidFloor: comparison(5.8), comparisonMidpoint: comparison(6.9), control }],
    dataChecks: { singleAssetEvents: 6, maxDeviationBpsSingle: 0, multiAssetEvents: 1, maxDeviationBpsMulti: 0 },
  };
}
