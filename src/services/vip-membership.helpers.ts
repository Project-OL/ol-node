import { VipMembershipTier } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { addUtcDays } from '../utils/datetime'

export const DIAMOND_COST = 1_000_000n
export const SVIP_COST = 12_990_000n
export const DIAMOND_PERIOD_DAYS = 30
export const SVIP_PERIOD_DAYS = 365
export const VIP_DAILY_GRANT_COINS = 35_000n
export const VIP_DURATION_CAP_DAYS = 730

/** UTC day length (JS Date has no leap seconds). */
export const VIP_MS_PER_DAY = 86_400_000

export type VipDisplayPurchase = {
  id?: string
  createdAt: Date
  tier: VipMembershipTier
  periodDays: number
  /** Stacked expiry after this purchase; reconstructed when omitted. */
  expiresAtAfter?: Date
}

export type VipDisplayState = {
  displayTier: VipMembershipTier | null
  /** When the current badge ends (last SVIP stack point, else last visible Diamond). */
  displayExpiresAt: Date | null
  /** Last purchase stacked expiry (same as `User.vipSubscriptionExpiresAt`). */
  membershipExpiresAt: Date | null
}

export function computeProposedExpiresAt(args: {
  now: Date
  currentExpiresAt: Date | null
  periodDays: number
}): Date {
  const base =
    args.currentExpiresAt != null && args.currentExpiresAt.getTime() > args.now.getTime()
      ? args.currentExpiresAt
      : args.now
  return addUtcDays(base, args.periodDays)
}

function sortPurchases(purchases: readonly VipDisplayPurchase[]): VipDisplayPurchase[] {
  return [...purchases].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime()
    if (t !== 0) return t
    return (a.id ?? '').localeCompare(b.id ?? '')
  })
}

/** Stacked `expiresAtAfter` per purchase, same rule as VIP purchase. */
export function stackedExpiresAtAfter(purchases: readonly VipDisplayPurchase[]): Date[] {
  const ordered = sortPurchases(purchases)
  let current: Date | null = null
  const ends: Date[] = []
  for (const p of ordered) {
    const end: Date =
      p.expiresAtAfter ??
      computeProposedExpiresAt({
        now: p.createdAt,
        currentExpiresAt: current,
        periodDays: p.periodDays,
      })
    ends.push(end)
    current = end
  }
  return ends
}

/**
 * Badge uses stacked purchase expiries (not leftover queued Diamond).
 * Diamonds whose stacked expiry is on or before the last SVIP stacked expiry are skipped.
 * `membershipExpiresAt` is always the last purchase's stacked expiry.
 */
export function resolveVipDisplayState(
  purchases: readonly VipDisplayPurchase[],
  now: Date,
): VipDisplayState {
  const empty: VipDisplayState = {
    displayTier: null,
    displayExpiresAt: null,
    membershipExpiresAt: null,
  }
  if (purchases.length === 0) return empty

  const ordered = sortPurchases(purchases)
  const ends = stackedExpiresAtAfter(ordered)
  const membershipExpiresAt = ends[ends.length - 1] ?? null
  const nowMs = now.getTime()

  let lastSvipEnd: Date | null = null
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.tier === VipMembershipTier.SVIP) lastSvipEnd = ends[i]!
  }
  const svipEndMs = lastSvipEnd?.getTime() ?? null

  let lastVisibleDiamondEnd: Date | null = null
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.tier !== VipMembershipTier.DIAMOND) continue
    const end = ends[i]!
    if (svipEndMs != null && end.getTime() <= svipEndMs) continue
    if (lastVisibleDiamondEnd == null || end.getTime() > lastVisibleDiamondEnd.getTime()) {
      lastVisibleDiamondEnd = end
    }
  }

  if (lastSvipEnd != null && nowMs < lastSvipEnd.getTime()) {
    return {
      displayTier: VipMembershipTier.SVIP,
      displayExpiresAt: lastSvipEnd,
      membershipExpiresAt,
    }
  }
  if (lastVisibleDiamondEnd != null && nowMs < lastVisibleDiamondEnd.getTime()) {
    return {
      displayTier: VipMembershipTier.DIAMOND,
      displayExpiresAt: lastVisibleDiamondEnd,
      membershipExpiresAt,
    }
  }
  return { ...empty, membershipExpiresAt }
}

export function assertWithinCap(proposedExpiresAt: Date, now: Date, capDays: number): void {
  const cap = addUtcDays(now, capDays)
  if (proposedExpiresAt.getTime() > cap.getTime()) {
    throw new AppError(
      400,
      'VIP membership cannot extend beyond 2 years from now',
      'VIP_DURATION_CAP',
    )
  }
}

/** Fan ranking / FanSpend increment: 1.2× coin cost when sender has active paid VIP (BigInt). */
export function fanSpendIncrementForGift(
  coinCost: bigint,
  senderHasActiveVipMembership: boolean,
): bigint {
  return senderHasActiveVipMembership ? (coinCost * 12n) / 10n : coinCost
}
