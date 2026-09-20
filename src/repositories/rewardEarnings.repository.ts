import { prismaRead } from '../config/database'

/**
 * Sum of qualifying reward earnings for `userId` in `[start, end)`:
 * any non-direct gift (livestream, video-call, self-gift, ...) plus video-call
 * per-minute points. Only excludes `direct` (chat) gifts.
 * Deliberately not pinned to an exact context spelling: Live-server's own
 * livestream gift path writes `context: "live_stream"` (not "livestream"),
 * so this mirrors the `<> 'direct'` pattern already used in
 * agencyCommission.repository.ts rather than an exact-match allow-list.
 * Shared by the Royal Host and Normal Host reward services — same earnings definition.
 */
export async function getQualifyingRewardEarningsForRange(
  userId: string,
  start: Date,
  end: Date,
): Promise<bigint> {
  const [row] = await prismaRead.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM(ple.amount), 0)::bigint AS total
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id
    WHERE w.currency_type = 'POINT'
      AND w.user_id = ${userId}::uuid
      AND ple.direction = 'CREDIT'
      AND ple.created_at >= ${start}
      AND ple.created_at < ${end}
      AND (
        ple.tx_type = 'VIDEO_CALL'
        OR (
          ple.tx_type = 'GIFT_RECEIVE'
          AND COALESCE(ple.metadata->>'context', 'livestream') <> 'direct'
        )
      )
  `
  return row?.total ?? 0n
}
