/**
 * One-off: BullMQ job counts for `live-photo-verify` (requires REDIS_URL in .env).
 * Jobs are consumed by `npm run worker:face-index` (not the general `npm run worker`).
 * Usage: npx tsx scripts/inspect-live-photo-queue.ts
 */
import "dotenv/config";
import { livePhotoVerifyQueue } from "../src/queues/live-photo.queue";
import { LIVE_PHOTO_VERIFY_QUEUE } from "../src/queues/live-photo.constants";

async function main() {
  const counts = await livePhotoVerifyQueue.getJobCounts();
  console.log("Queue:", LIVE_PHOTO_VERIFY_QUEUE);
  console.log("Counts:", counts);
  const waiting = await livePhotoVerifyQueue.getJobs(["wait"], 0, 10, true);
  console.log(
    "Sample waiting jobs:",
    waiting.map((j) => ({ id: j.id, name: j.name, data: j.data })),
  );
  const failed = await livePhotoVerifyQueue.getJobs(["failed"], 0, 5, true);
  console.log(
    "Recent failed:",
    failed.map((j) => ({ id: j.id, name: j.name, failedReason: j.failedReason })),
  );
  const completed = await livePhotoVerifyQueue.getJobs(["completed"], 0, 5, true);
  console.log(
    "Recent completed:",
    completed.map((j) => ({
      id: j.id,
      name: j.name,
      data: j.data,
      finishedOn: j.finishedOn,
    })),
  );
  await livePhotoVerifyQueue.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
