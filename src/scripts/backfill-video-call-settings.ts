/**
 * One-shot backfill: create default `video_call_settings` rows for users who
 * lack them. Live-server `initiateCall` requires a physical row; missing rows
 * surface as "Receiver has not enabled video calls."
 *
 * Idempotent — safe to re-run. Uses createMany skipDuplicates.
 *
 * Usage (run once on the API host / via ol-worker box):
 *   npx tsx scripts/backfill-video-call-settings.ts
 *   npx tsx scripts/backfill-video-call-settings.ts --dry-run
 *   npx tsx scripts/backfill-video-call-settings.ts --batch=500
 *   npx tsx scripts/backfill-video-call-settings.ts --userId=<uuid>
 */
import 'dotenv/config'
import { prisma } from '../config/database'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ script: 'backfill-video-call-settings' })

const DEFAULTS = {
  pricePerMin: 1800,
  blockLv5: false,
  blockLv10: false,
  acceptVideoCalls: true,
} as const

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main(): Promise<void> {
  const dryRun = hasFlag('dry-run')
  const singleUserId = argValue('userId')
  const batchSize = Math.max(1, Math.min(2000, Number(argValue('batch') ?? '500') || 500))

  log.info({ dryRun, singleUserId, batchSize }, 'starting video_call_settings backfill')

  if (singleUserId) {
    const existing = await prisma.videoCallSettings.findUnique({
      where: { userId: singleUserId },
      select: { userId: true },
    })
    if (existing) {
      log.info({ userId: singleUserId }, 'settings already exist — skip')
      return
    }
    const user = await prisma.user.findFirst({
      where: { id: singleUserId, status: { not: 'deleted' } },
      select: { id: true },
    })
    if (!user) {
      log.error({ userId: singleUserId }, 'user not found')
      process.exitCode = 1
      return
    }
    if (dryRun) {
      log.info({ userId: singleUserId }, 'dry-run would create settings')
      return
    }
    await prisma.videoCallSettings.create({
      data: { userId: singleUserId, ...DEFAULTS },
    })
    log.info({ userId: singleUserId }, 'created settings')
    return
  }

  let cursor: string | undefined
  let scanned = 0
  let created = 0
  let skipped = 0

  for (;;) {
    const users = await prisma.user.findMany({
      where: { status: { not: 'deleted' } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (users.length === 0) break

    scanned += users.length
    cursor = users[users.length - 1]!.id

    const ids = users.map((u) => u.id)
    const existing = await prisma.videoCallSettings.findMany({
      where: { userId: { in: ids } },
      select: { userId: true },
    })
    const have = new Set(existing.map((r) => r.userId))
    const missing = ids.filter((id) => !have.has(id))
    skipped += ids.length - missing.length

    if (missing.length === 0) {
      log.info({ scanned, created, skipped, cursor }, 'batch — nothing to create')
      continue
    }

    if (dryRun) {
      created += missing.length
      log.info(
        { scanned, wouldCreate: created, skipped, batchMissing: missing.length, cursor },
        'dry-run batch',
      )
      continue
    }

    const result = await prisma.videoCallSettings.createMany({
      data: missing.map((userId) => ({ userId, ...DEFAULTS })),
      skipDuplicates: true,
    })
    created += result.count
    log.info({ scanned, created, skipped, batchCreated: result.count, cursor }, 'batch done')
  }

  log.info({ scanned, created, skipped, dryRun }, 'backfill complete')
}

main()
  .catch((err) => {
    log.error({ err }, 'backfill failed')
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
