/**
 * RedressVault's accounting rules as a pure class, for the Glitch Simulator. It follows
 * contracts/src/RedressVault.sol in order: idempotency, bonus bound, strict equality, per-event
 * cap, recipient, record, epoch cap, then bond, reserve and claim. It is a simulation: nothing
 * here touches a chain. Parity with the real run is tested against mirror-sepolia.json.
 */
import { BPS, WAD, fixedBand, redress, type Liquidation, type PairBand, type Position } from "../../cre/sentinel-verdict/verdict";

export interface VaultReport {
  liquidationTx: string;
  logIndex: number;
  user: string;
  debtToCover: bigint;
  collateralSeized: bigint;
  bandLowE18: bigint;
  bandHighE18: bigint;
  debtPriceHighE18: bigint;
  liquidationBonusBps: bigint;
  verdict: number;
  redress: bigint;
  evidenceHash: string;
  oracleAdapter: string;
  liquidator: string;
  builder: string;
}

export interface Check {
  name: string;
  rule: string;
  pass: boolean;
}

export interface Claim {
  liquidator: string;
  builder: string;
  expected: bigint;
}

export interface Payout {
  checks: Check[];
  fromBond: bigint;
  fromReserve: bigint;
  queued: boolean;
  claim: Claim | null;
}

/** A Solidity revert, with the contract's error name. */
export class VaultRevert extends Error {
  constructor(readonly errorName: string, detail: string, readonly checks: Check[]) {
    super(detail);
    this.name = "VaultRevert";
  }
}

export interface VaultConfig {
  maxLiquidationBonusBps: bigint;
  epochCapBps: bigint;
}

export const DEFAULT_VAULT: VaultConfig = { maxLiquidationBonusBps: 2_000n, epochCapBps: 2_000n };

/** VerdictMath.computeRedress, by calling the same engine function the report came from. */
export function deriveRedress(r: VaultReport): bigint {
  const band: PairBand = { collateral: { low: r.bandLowE18, high: r.bandHighE18, n: 0, confidence: BPS }, debt: fixedBand(r.debtPriceHighE18) };
  const position: Position = { collateral: 0n, debt: 0n, ltBps: 0n, bonusBps: r.liquidationBonusBps };
  const liquidation: Liquidation = { block: 0n, logIndex: 0, collateralSeized: r.collateralSeized, debtCovered: r.debtToCover, oracleCollateralPrice: 0n, oracleDebtPrice: 0n };
  return redress(position, liquidation, band, r.verdict);
}

export class VaultSim {
  totalFunded = 0n;
  totalPaid = 0n;
  totalPaidFromBond = 0n;
  epochBudget = 0n;
  epochSpent = 0n;
  readonly bonds = new Map<string, bigint>();
  readonly claims = new Map<string, Claim>();
  private readonly seen = new Set<string>();

  constructor(private readonly cfg: VaultConfig = DEFAULT_VAULT) {}

  get available(): bigint {
    return this.totalFunded - this.totalPaid;
  }

  fund(amount: bigint): void {
    this.totalFunded += amount;
    this.epochBudget += (amount * this.cfg.epochCapBps) / BPS;
  }

  depositBond(adapter: string, amount: bigint): void {
    this.bonds.set(adapter, (this.bonds.get(adapter) ?? 0n) + amount);
  }

  onReport(r: VaultReport): Payout {
    const checks: Check[] = [];
    const check = (name: string, rule: string, pass: boolean, error: string, detail: string) => {
      checks.push({ name, rule, pass });
      if (!pass) throw new VaultRevert(error, detail, checks);
    };

    const key = `${r.liquidationTx}:${r.logIndex}`.toLowerCase();
    check("Idempotency", "each (txHash, logIndex) is processed once", !this.seen.has(key), "AlreadyProcessed", `event ${key} was already processed`);
    check("Bonus bound", `bonus ${r.liquidationBonusBps} bps ≤ ${this.cfg.maxLiquidationBonusBps} bps`, r.liquidationBonusBps <= this.cfg.maxLiquidationBonusBps, "BonusOutOfBounds", `bonus ${r.liquidationBonusBps} bps`);

    const calculated = deriveRedress(r);
    check("Strict equality", "reported redress = re-derived redress, to the wei", r.redress === calculated, "RedressMismatch", `reported ${r.redress}, calculated ${calculated}`);

    const cap = (r.collateralSeized * r.bandLowE18) / WAD;
    check("Per-event cap", "redress ≤ C · bandLow", r.redress <= cap, "RedressAboveCollateral", `redress ${r.redress}, cap ${cap}`);
    this.seen.add(key);

    if (r.redress === 0n) return { checks, fromBond: 0n, fromReserve: 0n, queued: false, claim: null };

    const bonded = this.bonds.get(r.oracleAdapter) ?? 0n;
    const fromBond = r.redress < bonded ? r.redress : bonded;
    const fromReserve = r.redress - fromBond;
    const fits = fromReserve <= this.available && this.epochSpent + fromReserve <= this.epochBudget;
    checks.push({ name: "Epoch cap", rule: "reserve share fits this epoch's budget, or the payout queues whole", pass: fits });
    if (!fits) return { checks, fromBond: 0n, fromReserve: 0n, queued: true, claim: null };

    this.bonds.set(r.oracleAdapter, bonded - fromBond);
    this.totalPaidFromBond += fromBond;
    this.totalPaid += fromReserve;
    this.epochSpent += fromReserve;
    const claim = { liquidator: r.liquidator, builder: r.builder, expected: r.redress };
    this.claims.set(key, claim);
    return { checks, fromBond, fromReserve, queued: false, claim };
  }
}
