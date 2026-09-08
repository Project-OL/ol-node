/**
 * Re-index stored face reference images into the configured Rekognition
 * collection, and reconcile `user_face_profiles.rekognition_face_id` with what
 * the collection actually holds.
 *
 * Why this exists: a collection is per-AWS-account, so moving accounts (or
 * rebuilding a collection) leaves every stored `rekognitionFaceId` pointing at
 * an id that no longer resolves. Face *search* still works — matches resolve by
 * `ExternalImageId` — so the breakage is silent until something acts on a
 * specific id: revoking a face calls `DeleteFaces` with the stored id and
 * quietly removes nothing.
 *
 * Two jobs, one pass:
 *   1. index  — image is in storage but the user is absent from the collection
 *   2. reconcile — user is already in the collection but the DB row disagrees
 *                  about the FaceId (the case after restoring a dump taken
 *                  from another environment)
 *
 * Idempotent: a second run reports everything as already correct.
 *
 * Usage (run on a host with DB + storage + Rekognition credentials):
 *   npm run faces:reindex -- --dry-run
 *   npm run faces:reindex
 *   npm run faces:reindex -- --status=INDEXED,DUPLICATE_FACE
 *   npm run faces:reindex -- --concurrency=8 --limit=50
 */
import 'dotenv/config'
import type { FaceProfileStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { env } from '../config/env'
import { indexUserFace, listFacesInCollection } from '../lib/rekognition.client'
import { storageService } from '../services/storage.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ script: 'reindex-face-collection' })

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`)

const DRY_RUN = hasFlag('dry-run')
const CONCURRENCY = Math.max(1, Number(argValue('concurrency') ?? 4))
const LIMIT = Number(argValue('limit') ?? 0)
const STATUSES = (argValue('status') ?? 'INDEXED')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean) as FaceProfileStatus[]

/**
 * Mirrors the sanitization inside `indexUserFace` — Rekognition rejects some
 * characters in ExternalImageId. User ids are UUIDs, so this is identity in
 * practice; kept in step with the client so the lookup key always matches what
 * was written.
 */
const toExternalImageId = (userId: string) => userId.replace(/[^A-Za-z0-9_.-]/g, '_')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isThrottle(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    e?.name === 'ProvisionedThroughputExceededException' ||
    e?.name === 'ThrottlingException' ||
    e?.$metadata?.httpStatusCode === 429
  )
}

/** Rekognition IndexFaces is TPS-limited; back off rather than fail the run. */
async function withThrottleRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let delay = 500
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isThrottle(err) || attempt >= attempts) throw err
      await sleep(delay)
      delay = Math.min(delay * 2, 8_000)
    }
  }
}

/** ExternalImageId -> FaceId for everything currently in the collection. */
async function loadCollectionFaces(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let nextToken: string | undefined
  do {
    const page = await withThrottleRetry(() =>
      listFacesInCollection({ maxResults: 1000, nextToken }),
    )
    for (const face of page.Faces ?? []) {
      if (face.ExternalImageId && face.FaceId) map.set(face.ExternalImageId, face.FaceId)
    }
    nextToken = page.NextToken
  } while (nextToken)
  return map
}

type Problem = { userId: string; key: string; reason: string }

async function main() {
  const collectionId = env.REKOGNITION_COLLECTION_ID
  log.info(
    { collectionId, statuses: STATUSES, concurrency: CONCURRENCY, dryRun: DRY_RUN },
    DRY_RUN ? 'dry run — no writes' : 'applying',
  )

  const inCollection = await loadCollectionFaces()
  log.info({ faces: inCollection.size }, 'collection scanned')

  const rows = await prisma.userFaceProfile.findMany({
    where: { status: { in: STATUSES } },
    select: { id: true, userId: true, s3KeyReference: true, rekognitionFaceId: true },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  })
  log.info({ profiles: rows.length }, 'profiles selected')

  const stats = {
    indexed: 0,
    reconciled: 0,
    alreadyCorrect: 0,
    noFaceDetected: 0,
    objectMissing: 0,
    failed: 0,
  }
  const problems: Problem[] = []
  let processed = 0

  async function handle(row: (typeof rows)[number]) {
    const external = toExternalImageId(row.userId)
    const existingFaceId = inCollection.get(external)
    try {
      // Already present: the image does not need re-indexing, but the row may
      // still carry an id from a different collection.
      if (existingFaceId) {
        if (row.rekognitionFaceId === existingFaceId) {
          stats.alreadyCorrect++
          return
        }
        if (!DRY_RUN) {
          await prisma.userFaceProfile.update({
            where: { id: row.id },
            data: { rekognitionFaceId: existingFaceId, collectionId },
          })
        }
        stats.reconciled++
        return
      }

      // HEAD before GET on purpose. `getObjectBuffer` maps a genuinely missing
      // object to the same generic `S3_DOWNLOAD_FAILED` as an infra fault *and*
      // records a circuit-breaker failure — enough absent keys would open the
      // breaker and abort the run. `headObjectMetadata` distinguishes the two
      // and leaves the breaker alone.
      await storageService.headObjectMetadata(row.s3KeyReference)
      if (DRY_RUN) {
        stats.indexed++
        return
      }
      const bytes = await storageService.getObjectBuffer(row.s3KeyReference)

      const result = await withThrottleRetry(() =>
        indexUserFace({ userId: row.userId, imageBytes: bytes }),
      )
      const faceId = result.FaceRecords?.[0]?.Face?.FaceId
      if (!faceId) {
        stats.noFaceDetected++
        problems.push({
          userId: row.userId,
          key: row.s3KeyReference,
          reason: `no face record (${JSON.stringify(
            (result.UnindexedFaces ?? []).flatMap((u) => u.Reasons ?? []),
          )})`,
        })
        return
      }

      await prisma.userFaceProfile.update({
        where: { id: row.id },
        data: { rekognitionFaceId: faceId, collectionId },
      })
      stats.indexed++
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string }
      // A missing object is a data problem worth listing separately from a
      // transient API failure — it means the reference image never made the
      // storage migration. `INVALID_MEDIA_OBJECT` is what `headObjectMetadata`
      // raises for a key that is not there.
      if (e?.code === 'INVALID_MEDIA_OBJECT' || e?.name === 'NoSuchKey' || e?.name === 'NotFound') {
        stats.objectMissing++
        problems.push({ userId: row.userId, key: row.s3KeyReference, reason: 'object missing' })
      } else {
        stats.failed++
        problems.push({
          userId: row.userId,
          key: row.s3KeyReference,
          reason: `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`,
        })
      }
    } finally {
      processed++
      if (processed % 250 === 0) log.info({ processed, total: rows.length }, 'progress')
    }
  }

  const queue = [...rows]
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await handle(next)
    }),
  )

  log.info({ ...stats, dryRun: DRY_RUN }, 'done')
  if (problems.length > 0) {
    log.warn({ count: problems.length }, 'problems (first 25 below)')
    for (const p of problems.slice(0, 25)) log.warn(p, 'problem')
  }

  await prisma.$disconnect()
  // A run that could not index something is not a success — surface it to CI
  // and to whoever is watching the cutover.
  if (stats.failed > 0 || stats.objectMissing > 0) process.exitCode = 1
}

main().catch(async (err) => {
  log.error({ err }, 'fatal')
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
