import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { normalHostRewardService } from './normal-host-reward.service'
import { royalHostRewardService } from './royal-host-reward.service'
import { livestreamRewardService, effectiveSecondsForSession } from './livestream-reward.service'
import { liveStreamRepository } from '../repositories/liveStream.repository'
import { rewardClaimsRepository } from '../repositories/rewardClaims.repository'
import { TYPE_LABEL } from './rewardClaims.service'
import { hasRoyalHostTag } from '../utils/royalHostTag'
import { addUtcDays, utcDateString, utcStartOfDay, utcStartOfWeek } from '../utils/datetime'

export type LiveTimingSessionDto = {
  streamId: string
  startedAt: string | null
  endedAt: string | null
  isLive: boolean
  effectiveDurationSeconds: number
}

export type LiveTimingWindowDto = {
  totalEffectiveSeconds: number
  sessionCount: number
  sessions: LiveTimingSessionDto[]
}

/**
 * Total effective (billable) session seconds for `userId` in `[rangeStart, rangeEnd)`,
 * plus the raw per-session breakdown — same `effectiveSecondsForSession` definition the
 * three reward services use, applied to an admin-chosen range instead of each service's own
 * internal day/week window.
 */
async function buildTimingWindow(
  userId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<LiveTimingWindowDto> {
  const sessions = await liveStreamRepository.getSessionsForUserInRange(
    userId,
    rangeStart,
    rangeEnd,
  )
  const withEffective = await Promise.all(
    sessions.map(async (s) => ({
      streamId: s.streamId,
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      isLive: s.isLive,
      effectiveDurationSeconds: await effectiveSecondsForSession(s),
    })),
  )
  withEffective.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))

  return {
    totalEffectiveSeconds: withEffective.reduce((sum, s) => sum + s.effectiveDurationSeconds, 0),
    sessionCount: withEffective.length,
    sessions: withEffective,
  }
}

export const adminUserRewardsOverviewService = {
  /**
   * One-call admin snapshot for a user: eligibility + today's/this-week's progress across all
   * three reward tracks (Normal Host is per-day, Royal Host is per-GMT-week, Livestream Streak
   * is per-day-since-join — each service's own `getStatus()` is reused as-is, not reimplemented),
   * their full claim/deduction history, and their live-session effective timing for today and
   * this week (Sunday 00:00 UTC boundary, matching Royal Host's own week definition).
   */
  async getRewardsOverview(userId: string) {
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        publicId: true,
        country: true,
        avatarUrl: true,
        adminTags: true,
      },
    })
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const now = new Date()
    const dayStart = utcStartOfDay(now)
    const dayEnd = addUtcDays(dayStart, 1)
    const weekStart = utcStartOfWeek(now)
    const weekEnd = addUtcDays(weekStart, 7)

    const [
      normalHostReward,
      royalHostReward,
      livestreamReward,
      today,
      thisWeek,
      claims,
      deductions,
    ] = await Promise.all([
      normalHostRewardService.getStatus(userId),
      royalHostRewardService.getStatus(userId),
      livestreamRewardService.getStatus(userId),
      buildTimingWindow(userId, dayStart, dayEnd),
      buildTimingWindow(userId, weekStart, weekEnd),
      rewardClaimsRepository.listClaimsForUsers({ userIds: [userId] }),
      rewardClaimsRepository.listDeductionsForUsers({ userIds: [userId] }),
    ])

    const reversedIds = await rewardClaimsRepository.findReversedLedgerEntryIds([
      ...claims.map((c) => c.ledgerEntryId),
      ...deductions.map((d) => d.ledgerEntryId),
    ])

    return {
      user: {
        userId: user.id,
        username: user.username,
        publicId: user.publicId.toString(),
        country: user.country,
        avatarUrl: user.avatarUrl,
        isRoyalHost: hasRoyalHostTag(user.adminTags),
      },
      generatedAt: now.toISOString(),
      normalHostReward,
      royalHostReward,
      livestreamReward,
      liveTiming: {
        today: { date: utcDateString(dayStart), ...today },
        thisWeek: {
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          ...thisWeek,
        },
      },
      claimHistory: {
        claims: claims.map((c) => ({
          type: c.type,
          typeLabel: TYPE_LABEL[c.type],
          date: c.claimDate.toISOString().slice(0, 10),
          pointsAmount: c.pointsAmount.toString(),
          ledgerEntryId: c.ledgerEntryId,
          claimedAt: c.claimedAt.toISOString(),
          reverted: reversedIds.has(c.ledgerEntryId),
        })),
        deductions: deductions.map((d) => ({
          ledgerEntryId: d.ledgerEntryId,
          amount: d.amount.toString(),
          description: d.description,
          adminUserId: d.adminUserId,
          createdAt: d.createdAt.toISOString(),
          reverted: reversedIds.has(d.ledgerEntryId),
        })),
      },
    }
  },
}
