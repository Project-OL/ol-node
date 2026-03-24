/**
 * Daily job at 2 AM UTC: permanently delete accounts past the 45-day deletion date.
 */

import { accountDeletionService } from '../services/account-deletion.service'

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

let accountDeletionTimeoutId: NodeJS.Timeout | null = null
let accountDeletionIntervalId: NodeJS.Timeout | null = null

export async function runAccountDeletionJob(): Promise<void> {
  try {
    const result = await accountDeletionService.runDeletionJob()
    if (result.deletedCount > 0) {
      console.info(`[Account Deletion Job] Permanently deleted ${result.deletedCount} account(s)`)
    }
    if (result.errors.length > 0) {
      console.error('[Account Deletion Job] Errors:', result.errors)
    }
  } catch (err) {
    console.error('[Account Deletion Job] Failed:', err)
  }
}

function getMsUntilNext2AmUtc(): number {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(2, 0, 0, 0)
  if (now >= next) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/**
 * Schedule the job to run daily at 2 AM UTC.
 * Returns a clear function for shutdown.
 */
export function scheduleAccountDeletionJob(): () => void {
  const run = () => {
    runAccountDeletionJob().catch((err) =>
      console.error('[Account Deletion Job] Unhandled error:', err),
    )
  }

  const scheduleNext = () => {
    run()
    accountDeletionIntervalId = setInterval(run, TWENTY_FOUR_HOURS_MS)
  }

  const msUntilNext = getMsUntilNext2AmUtc()
  accountDeletionTimeoutId = setTimeout(scheduleNext, msUntilNext)

  return () => {
    if (accountDeletionTimeoutId) {
      clearTimeout(accountDeletionTimeoutId)
      accountDeletionTimeoutId = null
    }
    if (accountDeletionIntervalId) {
      clearInterval(accountDeletionIntervalId)
      accountDeletionIntervalId = null
    }
  }
}
