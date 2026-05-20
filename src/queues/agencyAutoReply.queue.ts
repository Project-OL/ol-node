import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import { AGENCY_AUTO_REPLY_JOB, AGENCY_AUTO_REPLY_QUEUE } from "./agencyAutoReply.constants";

export type AutoReplyJobData = {
  conversationId: string;
  agencyUserId: string;
  autoReplyText: string;
  triggerMessageSeq: number;
};

export const agencyAutoReplyQueue = new Queue(AGENCY_AUTO_REPLY_QUEUE, {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export async function enqueueAutoReply(data: AutoReplyJobData): Promise<void> {
  const jobId = `auto-reply:${data.conversationId}:${data.triggerMessageSeq}`;
  await agencyAutoReplyQueue.add(AGENCY_AUTO_REPLY_JOB, data, {
    jobId,
    delay: 0,
  });
}
