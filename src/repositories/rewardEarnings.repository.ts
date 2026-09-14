import { prismaRead } from '../config/database'

/**
 * Sum of qualifying reward earnings for `userId` in `[start, end)`:
 * livestream gifts, video-call gifts, and video-call per-minute points.
 * Mirrors the JSON-metadata `context` filtering used in agencyCommission.repository.ts.
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
          AND COALESCE(ple.metadata->>'context', 'livestream') IN ('livestream', 'video_call')
        )
      )
  `
  return row?.total ?? 0n
}
