export enum VerdictType {
  VALID = 0,
  WRONGFUL = 1,
  EXCESS = 2,
  AMBIGUOUS = 3,
  INCONCLUSIVE = 4,
}

export interface LiquidationEventData {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  user: string;
  collateralAsset: string;
  debtAsset: string;
  debtToCover: bigint;
  collateralSeized: bigint;
}

export interface PriceBand {
  bandLow: bigint;
  bandHigh: bigint;
  debtPriceHigh: bigint;
  sourceCount: number;
}

export interface VerdictResult {
  liquidationTx: string;
  logIndex: number;
  blockNumber: number;
  user: string;
  collateralAsset: string;
  debtAsset: string;
  debtToCover: bigint;
  collateralSeized: bigint;
  bandLowE18: bigint;
  bandHighE18: bigint;
  debtPriceHighE18: bigint;
  verdict: VerdictType;
  sourceCount: number;
  redress: bigint;
  evidenceHash: string;
}

const WAD = 10n ** 18n;

export function computeRedress(
  verdict: VerdictType,
  collateralSeized: bigint,
  debtToCover: bigint,
  bandLowE18: bigint,
  debtPriceHighE18: bigint,
  bonusBps: bigint = 100n
): bigint {
  if (verdict === VerdictType.VALID || verdict === VerdictType.INCONCLUSIVE) {
    return 0n;
  }

  const collateralValueLow = (collateralSeized * bandLowE18) / WAD;
  const debtValueHigh = (debtToCover * debtPriceHighE18) / WAD;

  if (verdict === VerdictType.WRONGFUL) {
    return collateralValueLow > debtValueHigh ? collateralValueLow - debtValueHigh : 0n;
  }

  if (verdict === VerdictType.EXCESS || verdict === VerdictType.AMBIGUOUS) {
    const entitlement = (debtValueHigh * (10000n + bonusBps)) / 10000n;
    return collateralValueLow > entitlement ? collateralValueLow - entitlement : 0n;
  }

  return 0n;
}

