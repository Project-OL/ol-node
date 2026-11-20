import { isEpayConfigured } from '../lib/epay/epay-gateway.client'
import { epayPayinService } from '../services/epay-payin.service'
import { epayPayoutService } from '../services/epay-payout.service'
import { rootLogger } from '../utils/rootLogger'

export const EPAY_RECONCILE_QUEUE = 'epay-reconcile'
export const EPAY_RECONCILE_JOB = 'run'
export const EPAY_RECONCILE_EVERY_MS = 2 * 60 * 1000

const log = rootLogger.child({ module: 'epay-reconcile' })

/**
 * Epay requires callback AND active query ("必须是异步回调配合主动查询一起用"). This is the
 * query half: re-checks PENDING pay-ins and live payout attempts the callback has not
 * settled. No-op while Epay is disabled.
 */
export async function runEpayReconcileJob(): Promise<void> {
  if (!isEpayConfigured()) return
  const payin = await epayPayinService.reconcilePending()
  const payout = await epayPayoutService.reconcileLive()
  if (payin.checked > 0 || payout.checked > 0) {
    log.info({ payin, payout }, 'epay reconcile run')
  }
}
