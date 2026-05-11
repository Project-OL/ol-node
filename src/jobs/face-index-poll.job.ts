import { env } from '../config/env'
import { prisma } from '../config/database'
import { faceVerificationService } from '../services/face-verification.service'

/**
 * Picks up to `FACE_INDEX_BATCH` rows with `PENDING_INDEX` and runs Rekognition indexing.
 * Used by `src/worker-face-index.ts` (no Redis / BullMQ).
 */
export async function runFaceIndexPollOnce(): Promise<number> {
  const batch = Math.min(env.FACE_INDEX_BATCH, 50)
  const rows = await prisma.userFaceProfile.findMany({
    where: { status: 'PENDING_INDEX' },
    orderBy: { createdAt: 'asc' },
    take: batch,
    select: { id: true, userId: true, s3KeyReference: true },
  })
  for (const row of rows) {
    await faceVerificationService.processIndexingJob({
      userId: row.userId,
      faceProfileId: row.id,
      s3Key: row.s3KeyReference,
    })
  }
  return rows.length
}
