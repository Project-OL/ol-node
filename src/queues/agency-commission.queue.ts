import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import {
  AGENCY_LEVEL_BATCH_SIZE,
  AGENCY_LEVEL_JOB_BATCH,
  AGENCY_LEVEL_JOB_MASTER,
  AGENCY_LEVEL_RECOMPUTE_QUEUE,
} from "./agency-commission.constants";

const jobOpts = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 500,
};

export const agencyLevelRecomputeQueue = new Queue(AGENCY_LEVEL_RECOMPUTE_QUEUE, {
  connection: redisClient,
});

export async function enqueueAgencyRecomputeMaster(
  utcDate: string,
  force?: boolean,
): Promise<void> {
  await agencyLevelRecomputeQueue.add(
    AGENCY_LEVEL_JOB_MASTER,
    { utcDate, force: force === true },
    {
      ...jobOpts,
      jobId: `master:${utcDate}${force ? ":force" : ""}`,
    },
  );
}

export async function enqueueAgencyRecomputeBatch(
  utcDate: string,
  agencyUserIds: string[],
): Promise<void> {
  const start = agencyUserIds[0] ?? "";
  const end = agencyUserIds[agencyUserIds.length - 1] ?? "";
  await agencyLevelRecomputeQueue.add(
    AGENCY_LEVEL_JOB_BATCH,
    { utcDate, agencyUserIds },
    {
      ...jobOpts,
      jobId: `batch:${utcDate}:${start}-${end}`,
    },
  );
}

export { AGENCY_LEVEL_BATCH_SIZE };
