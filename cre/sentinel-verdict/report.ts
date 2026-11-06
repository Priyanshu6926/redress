/**
 * The report RedressVault.onReport decodes. REPORT_PARAMS must stay field-for-field
 * identical to `struct Verdict` in contracts/src/RedressVault.sol.
 */
import { encodeAbiParameters, type Address, type Hex } from "viem";

/** Mirrors RedressVault.MAX_LIQUIDATION_BONUS_BPS. */
export const MAX_LIQUIDATION_BONUS_BPS = 2_000n;

export const REPORT_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "liquidationTx", type: "bytes32" },
      { name: "logIndex", type: "uint32" },
      { name: "blockNumber", type: "uint64" },
      { name: "user", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "collateralSeized", type: "uint256" },
      { name: "bandLowE18", type: "uint256" },
      { name: "bandHighE18", type: "uint256" },
      { name: "debtPriceHighE18", type: "uint256" },
      { name: "liquidationBonusBps", type: "uint256" },
      { name: "verdict", type: "uint8" },
      { name: "sourceCount", type: "uint8" },
      { name: "redress", type: "uint256" },
      { name: "evidenceHash", type: "bytes32" },
    ],
  },
] as const;

export interface Report {
  liquidationTx: Hex;
  logIndex: number;
  blockNumber: bigint;
  user: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  collateralSeized: bigint;
  bandLowE18: bigint;
  bandHighE18: bigint;
  debtPriceHighE18: bigint;
  liquidationBonusBps: bigint;
  verdict: number;
  sourceCount: number;
  redress: bigint;
  evidenceHash: Hex;
}

export function encodeReport(report: Report): Hex {
  if (report.liquidationBonusBps > MAX_LIQUIDATION_BONUS_BPS) {
    throw new RangeError(`liquidation bonus above the vault maximum: ${report.liquidationBonusBps}`);
  }
  return encodeAbiParameters(REPORT_PARAMS, [report]);
}
