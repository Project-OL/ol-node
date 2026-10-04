/**
 * One-shot backfill: slide `sessions.expires_at` forward for sessions that are still live.
 *
 * Before the sliding-expiry fix, expires_at was fixed at login + 7 days and never moved on
 * refresh, while the refresh JWT (JWT_REFRESH_EXPIRES_IN, 30d) kept rotating. Sessions that
 * still refresh fine were therefore hidden from the device linked-accounts list, the admin
 * device view and the per-user session cap. This sets expires_at = updated_at + lifetime
 * (updated_at is bumped by every refresh rotation) for active, non-revoked sessions whose
 * refresh window is still open.
 *
 * Idempotent — safe to re-run. Only ever moves expires_at forward.
 *
 * Usage:
 *   npx tsx scripts/backfill-session-expiry.ts --dry-run
 *   npx tsx scripts/backfill-session-expiry.ts
 *   npx tsx scripts/backfill-session-expiry.ts --lifetime-days=30   # lifetime existing tokens were signed with
 */
import 'dotenv/config'
import { prisma } from '../src/config/database'
import { env } from '../src/config/env'
import { parseJwtExpiresToSeconds } from '../src/utils/jwt'
import { rootLogger } from '../src/utils/rootLogger'

const log = rootLogger.child({ script: 'backfill-session-expiry' })

const MIN_SESSION_SEC = 7 * 24 * 60 * 60

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  // Refresh JWTs already in the wild carry the lifetime they were signed with; when
  // JWT_REFRESH_EXPIRES_IN has since grown, pass that old lifetime so a row is never marked
  // live past its token's own `exp`. The next refresh slides it to the new lifetime.
  const daysArg = process.argv.find((a) => a.startsWith('--lifetime-days='))?.split('=')[1]
  const raw = env.JWT_REFRESH_EXPIRES_IN.trim()
  const lifetimeSec = daysArg
    ? Math.max(Number(daysArg) * 86_400, MIN_SESSION_SEC)
    : /^\d+\s*[smhd]$/i.test(raw)
      ? Math.max(parseJwtExpiresToSeconds(raw), MIN_SESSION_SEC)
      : MIN_SESSION_SEC
  if (!Number.isFinite(lifetimeSec)) throw new Error(`invalid --lifetime-days=${daysArg}`)

  log.info({ dryRun, lifetimeSec }, 'starting session expiry backfill')

  const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM sessions
    WHERE is_active = true
      AND is_revoked = false
      AND updated_at + (${lifetimeSec}::int * INTERVAL '1 second') > NOW()
      AND expires_at < updated_at + (${lifetimeSec}::int * INTERVAL '1 second')
  `
  log.info({ eligible: Number(count) }, 'eligible sessions')
  if (dryRun) return

  const updated = await prisma.$executeRaw`
    UPDATE sessions
    SET expires_at = updated_at + (${lifetimeSec}::int * INTERVAL '1 second')
    WHERE is_active = true
      AND is_revoked = false
      AND updated_at + (${lifetimeSec}::int * INTERVAL '1 second') > NOW()
      AND expires_at < updated_at + (${lifetimeSec}::int * INTERVAL '1 second')
  `
  // updated_at is left untouched on purpose (raw SQL bypasses @updatedAt), so a re-run
  // computes the same target and is a no-op.
  log.info({ updated }, 'backfill complete (device linked-accounts cache expires within 30 min)')
}

main()
  .catch((err) => {
    log.error({ err }, 'backfill failed')
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
