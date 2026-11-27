import { epayAutoPayoutService } from '../services/epay-auto-payout.service'

export const EPAY_AUTO_PAYOUT_QUEUE = 'epay-auto-payout'
export const EPAY_AUTO_PAYOUT_JOB = 'run'
export const EPAY_AUTO_PAYOUT_EVERY_MS = 60 * 1000

/** Automatic Epay payouts; a no-op while `epay_auto_payout_config.enabled` is false. */
export async function runEpayAutoPayoutJob(): Promise<void> {
  await epayAutoPayoutService.runOnce()
}
