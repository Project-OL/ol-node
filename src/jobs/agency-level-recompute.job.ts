import type { Job } from 'bullmq'
import { env } from '../config/env'
import {
  AGENCY_LEVEL_BATCH_SIZE,
  AGENCY_LEVEL_JOB_BATCH,
  AGENCY_LEVEL_JOB_MASTER,
} from '../queues/agency-commission.constants'
import { enqueueAgencyRecomputeBatch } from '../queues/agency-commission.queue'
import { agencyCommissionRepository } from '../repositories/agencyCommission.repository'
import { agencyCommissionService } from '../services/agencyCommission.service'
import { utcDateString, utcNow } from '../utils/datetime'

export async function processAgencyLevelRecomputeJob(job: Job): Promise<void> {
  if (job.name === AGENCY_LEVEL_JOB_MASTER) {
    await handleMaster(job as Job<{ utcDate?: string; force?: boolean }>)
  } else if (job.name === AGENCY_LEVEL_JOB_BATCH) {
    await handleBatch(job as Job<{ agencyUserIds: string[] }>)
  }
}

async function handleMaster(job: Job<{ utcDate?: string; force?: boolean }>): Promise<void> {
  const force = job.data.force === true
  if (!env.AGENCY_LEVEL_RECOMPUTE_ENABLED && !force) {
    console.info(
      '[agency level recompute] master skipped (set AGENCY_LEVEL_RECOMPUTE_ENABLED=true or use admin force)',
    )
    return
  }

  // Page all agencies so window totals can shrink when the oldest UTC day ages out.
  let cursor: string | null = null
  for (;;) {
    const batch = await agencyCommissionRepository.listAllAgencyUserIds({
      cursor,
      limit: AGENCY_LEVEL_BATCH_SIZE,
    })
    if (batch.length === 0) break
    const utcDate = job.data.utcDate ?? utcDateString(utcNow())
    await enqueueAgencyRecomputeBatch(utcDate, batch)
    cursor = batch[batch.length - 1]!
    if (batch.length < AGENCY_LEVEL_BATCH_SIZE) break
  }
}

async function handleBatch(job: Job<{ agencyUserIds: string[] }>): Promise<void> {
  const { agencyUserIds } = job.data
  for (const id of agencyUserIds) {
    // Always refresh after UTC date roll (same-day dedupe would skip midnight slide).
    await agencyCommissionService.recomputeAgencyLevel(id, { skipDailyDedupe: true })
  }
}
