/**
 * Generates the missing `gifts.thumbnail_url` for rows that predate thumbnail support.
 *
 *   npm run backfill:gift-thumbnails -- --dry-run
 *   npm run backfill:gift-thumbnails
 *   npm run backfill:gift-thumbnails -- --force        # redo rows that already have one
 *   npm run backfill:gift-thumbnails -- --limit=5
 *
 * Idempotent: the thumbnail key is derived from the source URL, so a re-run overwrites
 * the same objects. Safe to run against a live database — it only ever writes
 * `thumbnail_url`, and a gift whose thumbnail cannot be generated is left untouched and
 * keeps serving its original image.
 */
import { prisma } from '../config/database'
import { giftThumbnailService } from '../services/gift-thumbnail.service'
import { giftService } from '../services/gift.service'
import { fetchAssetBytes } from '../utils/remote-asset'

type Args = { dryRun: boolean; force: boolean; limit?: number }

function parseArgs(argv: string[]): Args {
  const dryRun = argv.includes('--dry-run')
  const force = argv.includes('--force')
  const limitArg = argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined
  return {
    dryRun,
    force,
    limit: Number.isFinite(limit) && (limit ?? 0) > 0 ? limit : undefined,
  }
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const gifts = await prisma.gift.findMany({
    where: args.force ? {} : { thumbnailUrl: null },
    select: { id: true, name: true, displayImageUrl: true, thumbnailUrl: true },
    orderBy: { displayOrder: 'asc' },
    ...(args.limit ? { take: args.limit } : {}),
  })

  console.log(
    `[backfill] ${gifts.length} gift(s) to process` +
      `${args.dryRun ? ' (dry run)' : ''}${args.force ? ' (force)' : ''}`,
  )

  let generated = 0
  let skipped = 0
  let failed = 0
  let sourceBytesTotal = 0
  let thumbBytesTotal = 0

  for (const gift of gifts) {
    // Measure the original so the run reports the actual saving, not an estimate.
    const source = await fetchAssetBytes(gift.displayImageUrl)
    const sourceBytes = source?.buffer.byteLength ?? 0

    if (args.dryRun) {
      if (!source) {
        console.log(`  SKIP  ${gift.name} — source not fetchable`)
        skipped += 1
        continue
      }
      console.log(`  WOULD ${gift.name} — source ${kb(sourceBytes)}`)
      sourceBytesTotal += sourceBytes
      generated += 1
      continue
    }

    let thumbnailUrl: string | null = null
    try {
      thumbnailUrl = await giftThumbnailService.generateForSource(gift.displayImageUrl)
    } catch (err) {
      console.error(`  FAIL  ${gift.name} — ${String(err)}`)
      failed += 1
      continue
    }

    if (!thumbnailUrl) {
      console.log(`  SKIP  ${gift.name} — no thumbnail generated (small, vector, or animated)`)
      skipped += 1
      continue
    }

    const thumb = await fetchAssetBytes(thumbnailUrl)
    const thumbBytes = thumb?.buffer.byteLength ?? 0
    sourceBytesTotal += sourceBytes
    thumbBytesTotal += thumbBytes

    await prisma.gift.update({ where: { id: gift.id }, data: { thumbnailUrl } })
    generated += 1
    console.log(`  OK    ${gift.name} — ${kb(sourceBytes)} -> ${kb(thumbBytes)}`)
  }

  if (!args.dryRun && generated > 0) {
    // The public gift list is Redis-cached for 10 minutes; drop it so the new URLs are
    // served immediately rather than after the TTL.
    await giftService.invalidateAllGiftCaches()
    console.log('[backfill] gift list caches invalidated')
  }

  console.log(
    `[backfill] done — generated ${generated}, skipped ${skipped}, failed ${failed}` +
      (sourceBytesTotal > 0
        ? `; catalog payload ${kb(sourceBytesTotal)} -> ${kb(thumbBytesTotal)}`
        : ''),
  )
}

main()
  .catch((err) => {
    console.error('[backfill] fatal', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    // Services pulled in here open Redis/queue handles that keep the loop alive.
    process.exit()
  })
