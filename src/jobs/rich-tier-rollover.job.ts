import type { Job } from "bullmq";
import { env } from "../config/env";
import {
  RICH_TIER_BATCH_SIZE,
  RICH_TIER_JOB_BATCH,
  RICH_TIER_JOB_MASTER,
} from "../queues/rich-tier.constants";
import { enqueueRolloverBatch } from "../queues/rich-tier.queue";
import { richTierRepository } from "../repositories/richTier.repository";
import { richTierService } from "../services/rich-tier.service";
import { utcNow, utcPreviousYearMonth } from "../utils/datetime";

export async function processRichTierRolloverJob(job: Job): Promise<void> {
  if (job.name === RICH_TIER_JOB_MASTER) {
    await handleMaster(
      job as Job<{ year?: number; month?: number; force?: boolean }>,
    );
  } else if (job.name === RICH_TIER_JOB_BATCH) {
    await handleBatch(
      job as Job<{ year: number; month: number; userIds: string[] }>,
    );
  }
}

async function handleMaster(
  job: Job<{ year?: number; month?: number; force?: boolean }>,
): Promise<void> {
  let year: number;
  let month: number;
  if (job.data.year != null && job.data.month != null) {
    year = job.data.year;
    month = job.data.month;
  } else {
    const p = utcPreviousYearMonth(utcNow());
    year = p.year;
    month = p.month;
  }
  const force = job.data.force === true;
  if (!env.RICH_TIER_ROLLOVER_ENABLED && !force) {
    console.info(
      "[rich-tier rollover] master skipped (RICH_TIER_ROLLOVER_ENABLED is not true); use admin force to test",
    );
    return;
  }

  let cursor = "";
  for (;;) {
    const ids = await richTierRepository.listUsersForRollover({
      year,
      month,
      cursor,
      limit: RICH_TIER_BATCH_SIZE,
    });
    if (ids.length === 0) break;
    await enqueueRolloverBatch(year, month, ids);
    cursor = ids[ids.length - 1]!;
    if (ids.length < RICH_TIER_BATCH_SIZE) break;
  }
}

async function handleBatch(
  job: Job<{ year: number; month: number; userIds: string[] }>,
): Promise<void> {
  const { year, month, userIds } = job.data;
  for (const userId of userIds) {
    await richTierService.processMonthlyRolloverForUser(userId, year, month);
  }
}
