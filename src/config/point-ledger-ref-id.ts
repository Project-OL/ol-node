import type { PointTxType } from '@prisma/client'

/**
 * Canonical `point_ledger_entries.ref_id` → source entity for cross-lookup.
 * Use the same refId on every ledger row tied to one business event (host + agent commission share one gift/subscription id).
 */
export const POINT_LEDGER_REF_ENTITY: Partial<Record<PointTxType, string>> = {
  GIFT_RECEIVE: 'gift_transaction',
  LIVESTREAM_GIFT: 'gift_transaction',
  AGENT_COMMISSION: 'gift_transaction | subscription | guardian | video_call_session',
  SUBSCRIPTION: 'subscription',
  GUARDIAN_PURCHASE: 'user_guardian',
  VIDEO_CALL: 'video_call_session',
  WITHDRAWAL: 'withdrawal',
  WITHDRAWAL_REFUND: 'withdrawal',
  WITHDRAWAL_ESCROW: 'withdrawal',
  WITHDRAWAL_ESCROW_SETTLED: 'withdrawal',
  PAYROLL_HOST_PAYOUT: 'withdrawal',
  PAYROLL_PROCESSING_REWARD: 'withdrawal',
  ADJUSTMENT: 'withdrawal',
  AGENT_POINT_TRANSFER: 'agent_point_transfer',
  TRANSFER_OUT: 'points_exchange',
  TRANSFER_IN: 'agent_point_transfer',
  AGENCY_FORCE_EXIT_PENALTY: 'support_ticket',
}

/** Infer entity label for API consumers fetching related records by refId. */
export function inferRefIdEntityType(txType: PointTxType): string | null {
  const raw = POINT_LEDGER_REF_ENTITY[txType]
  if (!raw) return null
  return raw.split('|')[0]!.trim()
}
