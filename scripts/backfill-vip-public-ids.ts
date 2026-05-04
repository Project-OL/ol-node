/**
 * Run once after deploy (low-traffic window). Idempotent — safe to re-run.
 * Ensures classification cursor is at least max(users.public_id), then runs horizon pre-gen.
 */
import 'dotenv/config'
import { prisma } from '../src/config/database'
import { classificationProgressRepository } from '../src/repositories/classification-progress.repository'
import { publicIdPreGenerationService } from '../src/services/public-id-pre-generation.service'
import { rootLogger } from '../src/utils/rootLogger'

const log = rootLogger.child({ script: 'backfill-vip-public-ids' })

async function main(): Promise<void> {
  const maxUserPublicId =
    (await prisma.user.aggregate({ _max: { publicId: true } }))._max.publicId ?? 0n
  const startFrom = maxUserPublicId + 1n

  const current = await classificationProgressRepository.get()
  if (current < startFrom) {
    log.info(
      { from: current.toString(), to: (startFrom - 1n).toString() },
      '[backfill] advancing classification cursor to max(users.public_id)',
    )
    await classificationProgressRepository.set(startFrom - 1n)
  }

  await publicIdPreGenerationService.runHorizonJob()
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
