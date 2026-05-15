/**
 * One-off: DB + Redis lock for a user's live photo row.
 * Usage: npx tsx scripts/inspect-live-photo-user.ts <userId>
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { redisClient } from "../src/config/redis";
import { RedisKeys } from "../src/config/redis";

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: npx tsx scripts/inspect-live-photo-user.ts <userId>");
    process.exit(1);
  }
  const row = await prisma.userLivePhoto.findUnique({ where: { userId } });
  const face = await prisma.userFaceProfile.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const attempts = await prisma.livePhotoVerificationAttempt.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      createdAt: true,
      matched: true,
      failureReason: true,
      similarityScore: true,
      processingLatencyMs: true,
    },
  });
  const lockKey = RedisKeys.livePhotoVerifyLock(userId);
  const lockVal = await redisClient.get(lockKey);
  const profileCache = await redisClient.get(RedisKeys.livePhotoProfile(userId));
  console.log(JSON.stringify({ row, face: face ? { id: face.id, status: face.status, s3KeyReference: face.s3KeyReference } : null, attempts, redisLock: lockVal, livePhotoProfileCache: profileCache }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
