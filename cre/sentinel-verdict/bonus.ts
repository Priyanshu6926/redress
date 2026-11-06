/**
 * Effective liquidation bonus for a position, following Aave v3's LiquidationLogic:
 * the E-Mode bonus applies only if the user is in a category and the collateral is
 * enabled in that category's collateral bitmap. Otherwise the reserve bonus applies.
 *
 * Aave stores the bonus as 10,000 + bonus, so 10,100 is 1%. Pure.
 */
export interface BonusInputs {
  /** Reserve configuration word from Pool.getConfiguration(collateral). */
  reserveConfig: bigint;
  /** Pool.getUserEMode(user). */
  eModeCategory: bigint;
  /** Raw bonus from Pool.getEModeCategoryCollateralConfig(category). */
  eModeBonus: bigint;
  /** Pool.getEModeCategoryCollateralBitmap(category). */
  collateralBitmap: bigint;
  /** Collateral reserve id, from Pool.getReserveData(collateral).id. */
  reserveId: bigint;
}

const BONUS_SHIFT = 32n;
const BONUS_MASK = 0xffffn;
const NO_BONUS = 10_000n;

export function effectiveBonusBps(i: BonusInputs): bigint {
  const inCategory = i.eModeCategory !== 0n && ((i.collateralBitmap >> i.reserveId) & 1n) === 1n;
  const raw = inCategory ? i.eModeBonus : (i.reserveConfig >> BONUS_SHIFT) & BONUS_MASK;
  if (raw < NO_BONUS) throw new RangeError(`invalid Aave liquidation bonus: ${raw}`);
  return raw - NO_BONUS;
}
