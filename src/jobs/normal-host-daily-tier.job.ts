import type { Job } from 'bullmq'
import { normalHostRewardService } from '../services/normal-host-reward.service'
import { utcStartOfDay } from '../utils/datetime'

/**
 * Records every host's Normal Host tier for the UTC day, from receiving up to 00:00 UTC.
 * `rewardDate` (YYYY-MM-DD) re-runs a specific day; existing rows are never overwritten.
 */
export async function processNormalHostDailyTierJob(
  job: Job<{ rewardDate?: string }>,
): Promise<void> {
  const rewardDate = job.data.rewardDate
    ? utcStartOfDay(new Date(`${job.data.rewardDate}T00:00:00Z`))
    : utcStartOfDay(new Date())
  const result = await normalHostRewardService.recomputeDailyTiers(rewardDate)
  console.info('[normal-host daily tier] recomputed', result)
}
