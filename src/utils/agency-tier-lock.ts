/**
 * Admin-assigned agency commission tier lock.
 *
 * While the lock is active, recomputes use:
 *   effective = max(actual + bonus, minWindowPoints(lockLevel))
 * so the assigned tier is a floor (can rise, cannot drop below).
 * Bonus is signed so demotions stick until lockUntil.
 */

export type AgencyTierLockState = {
  tierLockLevel: string | null
  tierLockUntil: Date | null
  tierLockBonusPoints: bigint | null
}

export function isAgencyTierLockActive(lock: AgencyTierLockState, now: Date): boolean {
  return (
    lock.tierLockUntil != null &&
    lock.tierLockUntil.getTime() > now.getTime() &&
    lock.tierLockLevel != null &&
    lock.tierLockLevel.length > 0 &&
    lock.tierLockBonusPoints != null
  )
}

export function computeTierLockBonus(minWindowPoints: bigint, actualAtAssignment: bigint): bigint {
  return minWindowPoints - actualAtAssignment
}

export function lockUntilFromNow(now: Date, totalMinutes: number): Date {
  const minutes = Math.max(1, Math.floor(totalMinutes))
  return new Date(now.getTime() + minutes * 60_000)
}

export function effectiveTierWindowTotal(params: {
  actual: bigint
  lock: AgencyTierLockState
  lockLevelMinWindowPoints: bigint | null
  now: Date
}): { effective: bigint; lockActive: boolean } {
  if (
    !isAgencyTierLockActive(params.lock, params.now) ||
    params.lockLevelMinWindowPoints == null
  ) {
    return { effective: params.actual, lockActive: false }
  }
  const withBonus = params.actual + params.lock.tierLockBonusPoints!
  const floor = params.lockLevelMinWindowPoints
  const effective = withBonus > floor ? withBonus : floor
  return { effective, lockActive: true }
}

export function matchAgencyLevel(
  total: bigint,
  levels: Array<{ level: string; minWindowPoints: bigint }>,
): string {
  let newLevel = levels[0]?.level ?? 'D'
  for (let i = levels.length - 1; i >= 0; i--) {
    const row = levels[i]!
    if (total >= row.minWindowPoints) {
      newLevel = row.level
      break
    }
  }
  return newLevel
}

export function serializeAgencyTierLock(
  lock: AgencyTierLockState,
  now: Date,
): {
  tierLockLevel: string | null
  tierLockUntil: string | null
  tierLockBonusPoints: string | null
} {
  if (!isAgencyTierLockActive(lock, now)) {
    return { tierLockLevel: null, tierLockUntil: null, tierLockBonusPoints: null }
  }
  return {
    tierLockLevel: lock.tierLockLevel,
    tierLockUntil: lock.tierLockUntil!.toISOString(),
    tierLockBonusPoints: lock.tierLockBonusPoints!.toString(),
  }
}
