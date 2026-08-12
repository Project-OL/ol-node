import type { PointTxType, WithdrawalStatus } from '@prisma/client'
import { PointTxType as PointTx } from '@prisma/client'

/** Admin may reverse a withdrawal within this age from `requestedAt`. */
export const ADMIN_WITHDRAWAL_REVERT_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000

/** Statuses eligible for `POST /admin/agency/withdrawal/:id/reverse` (when within age window). */
export const ADMIN_REVERSIBLE_WITHDRAWAL_STATUSES: ReadonlySet<WithdrawalStatus> = new Set([
  'PAID',
  'DISPUTED',
  'PENDING',
  'PENDING_PLATFORM',
  'WAITING',
])

export function isAdminWithdrawalRevertable(params: {
  status: WithdrawalStatus
  requestedAt: Date
  now?: Date
}): boolean {
  if (!ADMIN_REVERSIBLE_WITHDRAWAL_STATUSES.has(params.status)) return false
  const now = params.now ?? new Date()
  return now.getTime() - params.requestedAt.getTime() <= ADMIN_WITHDRAWAL_REVERT_MAX_AGE_MS
}

/** Host debit / escrow ledger types that link to a withdrawal via `refId`. */
export const ADMIN_WITHDRAWAL_LEDGER_TX_TYPES = new Set<PointTxType>([
  PointTx.WITHDRAWAL,
  PointTx.WITHDRAWAL_ESCROW,
  PointTx.WITHDRAWAL_ESCROW_SETTLED,
])
