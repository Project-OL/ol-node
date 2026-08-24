import { addUtcDays, utcDateString } from '../../utils/datetime'

export const VIP_EXPIRY_TOLERANCE_MS = 2_000

export type VipPurchaseReplayRow = {
  id: string
  createdAt: Date
  periodDays: number
  expiresAtAfter: Date
  coinCost: bigint
  ledgerEntryId: string
}

/** Replay purchase stack the same way as vip-membership purchase (ignore duration cap). */
export function reconstructVipExpiresAt(purchases: VipPurchaseReplayRow[]): Date | null {
  if (purchases.length === 0) return null
  const ordered = [...purchases].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  let current: Date | null = null
  for (const p of ordered) {
    const base =
      current != null && current.getTime() > p.createdAt.getTime() ? current : p.createdAt
    current = addUtcDays(base, p.periodDays)
  }
  return current
}

export function vipExpiresDisagree(
  actual: Date | null | undefined,
  expected: Date | null,
): boolean {
  if (actual == null && expected == null) return false
  if (actual == null || expected == null) return true
  return Math.abs(actual.getTime() - expected.getTime()) > VIP_EXPIRY_TOLERANCE_MS
}

export function auditUtcDayKey(d: Date = new Date()): string {
  return utcDateString(d)
}
