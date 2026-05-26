import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import { LIVE_SESSION_JOBS, LIVE_SESSION_QUEUE } from "./live-session.constants";

export const liveSessionQueue = new Queue(LIVE_SESSION_QUEUE, {
  connection: redisClient,
});

/**
 * Enqueues a delayed safety-net job for a session that just started.
 * If the session ends cleanly, the job becomes a no-op (checks DB status).
 */
export async function enqueueLiveSessionSafetyNet(
  sessionId: string,
  hostUserId: string,
  timeoutHours: number,
): Promise<void> {
  await liveSessionQueue.add(
    LIVE_SESSION_JOBS.SAFETY_NET_SESSION,
    { sessionId, hostUserId },
    {
      delay: timeoutHours * 60 * 60 * 1000,
      jobId: `safety-net-session-${sessionId}`,
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );
}
