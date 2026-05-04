import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import {
  AGENCY_LEAVE_AUTO_APPROVE_JOB,
  AGENCY_LEAVE_AUTO_APPROVE_QUEUE,
} from "./agency.constants";

export const agencyLeaveAutoApproveQueue = new Queue(
  AGENCY_LEAVE_AUTO_APPROVE_QUEUE,
  {
    connection: redisClient,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  },
);

/** BullMQ disallows `:` in custom jobIds unless formatted for repeatable jobs — use a safe id. */
export function agencyLeaveDelayedJobId(applicationId: string): string {
  return `agency-leave-auto-${applicationId}`;
}

export async function enqueueLeaveAutoApprove(
  applicationId: string,
  runAt: Date,
): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  await agencyLeaveAutoApproveQueue.add(
    AGENCY_LEAVE_AUTO_APPROVE_JOB,
    { applicationId },
    {
      jobId: agencyLeaveDelayedJobId(applicationId),
      delay,
    },
  );
}

export async function removeLeaveAutoApproveJob(
  applicationId: string,
): Promise<void> {
  const job = await agencyLeaveAutoApproveQueue.getJob(
    agencyLeaveDelayedJobId(applicationId),
  );
  await job?.remove();
}
