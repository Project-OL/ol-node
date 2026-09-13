import type { Job } from 'bullmq'
import { env } from '../config/env'
import { prismaRead } from '../config/database'
import { adminUserTagsService } from '../services/admin-user-tags.service'
import { royalHostRewardConfigService } from '../services/royalHostRewardConfig.service'
import { royalHostRewardRepository } from '../repositories/royalHostReward.repository'
import { auditService } from '../services/audit.service'
import { addUtcDays, utcDateString, utcStartOfWeek } from '../utils/datetime'
import {
  ROYAL_HOST_BATCH_SIZE,
  ROYAL_HOST_JOB_BATCH,
  ROYAL_HOST_JOB_MASTER,
} from '../queues/royalHost.constants'
import { enqueueEvalBatch } from '../queues/royalHost.queue'

const ROYAL_HOST_TAG = 'royal host'

export async function processRoyalHostWeeklyEvalJob(job: Job): Promise<void> {
  if (job.name === ROYAL_HOST_JOB_MASTER) {
    await handleMaster(job as Job<{ weekStart?: string; force?: boolean }>)
  } else if (job.name === ROYAL_HOST_JOB_BATCH) {
    await handleBatch(job as Job<{ weekStart: string; userIds: string[] }>)
  }
}

async function handleMaster(job: Job<{ weekStart?: string; force?: boolean }>): Promise<void> {
  const force = job.data.force === true
  if (!env.ROYAL_HOST_WEEKLY_EVAL_ENABLED && !force) {
    console.info(
      '[royal-host weekly eval] master skipped (ROYAL_HOST_WEEKLY_EVAL_ENABLED is not true); use admin force to test',
    )
    return
  }

  // The job fires at the new week's boundary; evaluate the week that just closed.
  const weekStart = job.data.weekStart
    ? new Date(job.data.weekStart)
    : addUtcDays(utcStartOfWeek(new Date()), -7)

  let cursor = ''
  for (;;) {
    const ids = await royalHostRewardRepository.listTaggedUsers({
      cursor,
      limit: ROYAL_HOST_BATCH_SIZE,
    })
    if (ids.length === 0) break
    await enqueueEvalBatch(weekStart, ids)
    cursor = ids[ids.length - 1]!
    if (ids.length < ROYAL_HOST_BATCH_SIZE) break
  }
}

async function handleBatch(job: Job<{ weekStart: string; userIds: string[] }>): Promise<void> {
  const weekStart = new Date(job.data.weekStart)
  const weekEnd = addUtcDays(weekStart, 7)
  const config = await royalHostRewardConfigService.getConfig()

  for (const userId of job.data.userIds) {
    const [earningsTotal, priorEval, user] = await Promise.all([
      royalHostRewardRepository.getQualifyingEarningsForRange(userId, weekStart, weekEnd),
      royalHostRewardRepository.getLatestEvaluation(userId, weekStart),
      prismaRead.user.findUnique({ where: { id: userId }, select: { adminTags: true } }),
    ])
    if (!user) continue

    const targetMet = earningsTotal >= config.autoRevokeEarningThresholdBigInt
    const priorMissCount = priorEval?.consecutiveMissCountAfterThisWeek ?? 0
    const consecutiveMissCountAfterThisWeek = targetMet ? 0 : priorMissCount + 1
    const stillTagged = user.adminTags.some((t) => t.trim().toLowerCase() === ROYAL_HOST_TAG)
    const shouldRevoke =
      stillTagged && consecutiveMissCountAfterThisWeek >= config.consecutiveMissWeeksLimit

    await royalHostRewardRepository.upsertEvaluation({
      userId,
      weekStart,
      earningsTotal,
      targetMet,
      consecutiveMissCountAfterThisWeek,
      tagRevokedAfterThisWeek: shouldRevoke,
    })

    if (shouldRevoke) {
      const remainingTags = user.adminTags.filter((t) => t.trim().toLowerCase() !== ROYAL_HOST_TAG)
      await adminUserTagsService.setTags(userId, remainingTags)
      auditService.log({
        userId,
        actionType: 'SYSTEM_ROYAL_HOST_TAG_REVOKED',
        actionStatus: 'success',
        actionDetails: {
          weekStart: utcDateString(weekStart),
          consecutiveMissedWeeks: consecutiveMissCountAfterThisWeek,
          earningsTotal: earningsTotal.toString(),
        },
      })
    }
  }
}
