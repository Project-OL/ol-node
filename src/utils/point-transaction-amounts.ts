import type { PointTxType } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { formatPointsAsUsd, POINTS_PER_USD } from './points-currency'

export type PointLedgerAmountContext = {
  txType: PointTxType
  amount: bigint
  refId: string | null
  metadata: Prisma.JsonValue | null
  withdrawal?: {
    grossPoints: bigint
    hostPayoutUsd: Prisma.Decimal | null
    platformFeePoints: bigint | null
  } | null
}

export type PointAmountBreakdown = {
  /** Points moved in this ledger row (absolute). */
  points: string
  /** USD at platform rate (10_000 pts = $1). */
  usdAmount: string
  pointsPerUsd: number
  /** e.g. `"$10.00 = 100,000 points"` */
  conversionLabel: string
  localCurrency: {
    code: string
    amount: string
    /** USD amount used for FX (may differ from usdAmount when fees apply). */
    usdBasis: string
  } | null
  /** Net USD received where fees apply (payroll/withdrawal); else same as usdAmount. */
  actualAmountReceivedUsd: string
}

const WITHDRAWAL_REF_TX_TYPES = new Set<PointTxType>([
  'WITHDRAWAL',
  'WITHDRAWAL_REFUND',
  'WITHDRAWAL_ESCROW',
  'WITHDRAWAL_ESCROW_SETTLED',
  'PAYROLL_HOST_PAYOUT',
  'PAYROLL_PROCESSING_REWARD',
])

function formatPointsDisplay(points: bigint): string {
  return points.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function usdToLocal(amountUsd: number, inrPerUsd: number): string {
  return (amountUsd * inrPerUsd).toFixed(2)
}

/**
 * Resolve display refId — prefers column, then known metadata keys.
 */
export function resolvePointLedgerRefId(
  refId: string | null | undefined,
  metadata: Prisma.JsonValue | null | undefined,
): string | null {
  if (refId && refId.trim().length > 0) return refId
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }
  const m = metadata as Record<string, unknown>
  for (const key of ['transferId', 'withdrawalId', 'subscriptionId', 'giftTransactionId']) {
    const v = m[key]
    if (typeof v === 'string' && v.trim().length > 0) return v
  }
  return null
}

export function buildPointAmountBreakdown(
  ctx: PointLedgerAmountContext,
  inrPerUsd: number,
): PointAmountBreakdown {
  const points = ctx.amount
  const baseUsd = formatPointsAsUsd(points)
  const conversionLabel = `$${baseUsd} = ${formatPointsDisplay(points)} points`

  let actualUsd = baseUsd
  let localUsdBasis = Number(baseUsd)

  if (ctx.withdrawal && WITHDRAWAL_REF_TX_TYPES.has(ctx.txType)) {
    const grossUsd = Number(ctx.withdrawal.grossPoints) / Number(POINTS_PER_USD)
    if (ctx.txType === 'PAYROLL_HOST_PAYOUT' || ctx.txType === 'WITHDRAWAL_ESCROW_SETTLED') {
      if (ctx.withdrawal.hostPayoutUsd != null) {
        actualUsd = new Prisma.Decimal(ctx.withdrawal.hostPayoutUsd.toString()).toFixed(2)
        localUsdBasis = Number(actualUsd)
      }
    } else if (
      ctx.txType === 'WITHDRAWAL_ESCROW' ||
      ctx.txType === 'WITHDRAWAL' ||
      ctx.txType === 'WITHDRAWAL_REFUND'
    ) {
      actualUsd = grossUsd.toFixed(2)
      localUsdBasis = grossUsd
      if (ctx.txType === 'WITHDRAWAL_REFUND' && ctx.withdrawal.hostPayoutUsd != null) {
        actualUsd = new Prisma.Decimal(ctx.withdrawal.hostPayoutUsd.toString()).toFixed(2)
        localUsdBasis = Number(actualUsd)
      }
    } else if (ctx.txType === 'PAYROLL_PROCESSING_REWARD') {
      actualUsd = baseUsd
      localUsdBasis = Number(baseUsd)
    }
  }

  return {
    points: points.toString(),
    usdAmount: baseUsd,
    pointsPerUsd: Number(POINTS_PER_USD),
    conversionLabel,
    localCurrency: {
      code: 'INR',
      amount: usdToLocal(localUsdBasis, inrPerUsd),
      usdBasis: localUsdBasis.toFixed(2),
    },
    actualAmountReceivedUsd: actualUsd,
  }
}

export async function loadWithdrawalAmountContext(
  refId: string | null,
  txType: PointTxType,
): Promise<PointLedgerAmountContext['withdrawal'] | null> {
  if (!refId || !WITHDRAWAL_REF_TX_TYPES.has(txType)) return null
  const { prismaRead } = await import('../config/database')
  const row = await prismaRead.withdrawal.findUnique({
    where: { id: refId },
    select: {
      amountPoints: true,
      hostPayoutUsd: true,
      platformFeePoints: true,
    },
  })
  if (!row) return null
  return {
    grossPoints: row.amountPoints,
    hostPayoutUsd: row.hostPayoutUsd,
    platformFeePoints: row.platformFeePoints,
  }
}
