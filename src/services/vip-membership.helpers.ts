import { AppError } from "../middlewares/errorHandler";
import { addUtcDays } from "../utils/datetime";

export const DIAMOND_COST = 1_000_000n;
export const SVIP_COST = 12_990_000n;
export const DIAMOND_PERIOD_DAYS = 30;
export const SVIP_PERIOD_DAYS = 365;
export const VIP_DAILY_GRANT_COINS = 35_000n;
export const VIP_DURATION_CAP_DAYS = 730;

export function computeProposedExpiresAt(args: {
  now: Date;
  currentExpiresAt: Date | null;
  periodDays: number;
}): Date {
  const base =
    args.currentExpiresAt != null &&
    args.currentExpiresAt.getTime() > args.now.getTime()
      ? args.currentExpiresAt
      : args.now;
  return addUtcDays(base, args.periodDays);
}

export function assertWithinCap(
  proposedExpiresAt: Date,
  now: Date,
  capDays: number,
): void {
  const cap = addUtcDays(now, capDays);
  if (proposedExpiresAt.getTime() > cap.getTime()) {
    throw new AppError(
      400,
      "VIP membership cannot extend beyond 2 years from now",
      "VIP_DURATION_CAP",
    );
  }
}

/** Fan ranking / FanSpend increment: 1.2× coin cost when sender has active paid VIP (BigInt). */
export function fanSpendIncrementForGift(
  coinCost: bigint,
  senderHasActiveVipMembership: boolean,
): bigint {
  return senderHasActiveVipMembership ? (coinCost * 12n) / 10n : coinCost;
}
