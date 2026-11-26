import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

/**
 * Payment suspect list: identities (phone, email, device, user) tied to a refunded purchase.
 * Today it is an admin flag only. Later automation (signup / login checks) can read it through
 * `isSuspect`, which is one unique-index lookup.
 */

export type SuspectIdentityType = 'PHONE' | 'EMAIL' | 'DEVICE' | 'USER'
export const SUSPECT_IDENTITY_TYPES: readonly SuspectIdentityType[] = [
  'PHONE',
  'EMAIL',
  'DEVICE',
  'USER',
]
export type SuspectStatus = 'ACTIVE' | 'CLEARED'

export interface SuspectIdentity {
  type: SuspectIdentityType
  value: string
}

export function normalizeSuspectValue(type: SuspectIdentityType, value: string): string {
  const v = value.trim()
  if (type === 'EMAIL') return v.toLowerCase()
  if (type === 'PHONE') return v.replace(/[\s\-()]/g, '')
  return v
}

/** Phone, email, recent device ids and the user id itself. Deduplicated, never empty values. */
export async function collectUserIdentities(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SuspectIdentity[]> {
  const [identifiers, sessions] = await Promise.all([
    tx.authIdentifier.findMany({
      where: { userId, provider: { in: ['email', 'phone'] } },
      select: { provider: true, identifier: true },
    }),
    tx.session.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - 180 * 86_400_000) } },
      select: { deviceId: true },
      distinct: ['deviceId'],
      take: 50,
    }),
  ])
  const out: SuspectIdentity[] = [{ type: 'USER', value: userId }]
  for (const a of identifiers) {
    out.push({ type: a.provider === 'email' ? 'EMAIL' : 'PHONE', value: a.identifier })
  }
  for (const s of sessions) if (s.deviceId) out.push({ type: 'DEVICE', value: s.deviceId })
  const seen = new Set<string>()
  return out
    .map((i) => ({ type: i.type, value: normalizeSuspectValue(i.type, i.value).slice(0, 255) }))
    .filter((i) => {
      const k = `${i.type}:${i.value}`
      if (!i.value || seen.has(k)) return false
      seen.add(k)
      return true
    })
}

export const paymentSuspectsService = {
  /**
   * Upsert identities inside the caller's transaction. A new identity gets a row; a known one
   * is re-activated with `hitCount + 1` and points at the newest user / refund.
   */
  async flagInTx(
    tx: Prisma.TransactionClient,
    params: {
      identities: SuspectIdentity[]
      userId: string
      reason: string
      sourceTxnId: string | null
    },
  ): Promise<number> {
    if (params.identities.length === 0) return 0
    const values = params.identities.map(
      (i) =>
        Prisma.sql`(${randomUUID()}::uuid, ${i.type}, ${i.value}, ${params.userId}::uuid, ${params.reason}, ${params.sourceTxnId}::uuid, 'ACTIVE', 1, now(), now(), now())`,
    )
    return tx.$executeRaw`
      INSERT INTO payment_suspects
        (id, identity_type, identity_value, user_id, reason, source_txn_id, status, hit_count,
         last_flagged_at, created_at, updated_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (identity_type, identity_value) DO UPDATE SET
        hit_count = payment_suspects.hit_count + 1,
        user_id = EXCLUDED.user_id,
        reason = EXCLUDED.reason,
        source_txn_id = EXCLUDED.source_txn_id,
        status = 'ACTIVE',
        cleared_at = NULL,
        cleared_by_admin_id = NULL,
        last_flagged_at = now(),
        updated_at = now()`
  },

  /** For later automation (signup / login): is this identity on the ACTIVE list? */
  async isSuspect(type: SuspectIdentityType, value: string): Promise<boolean> {
    const row = await prismaRead.paymentSuspect.findUnique({
      where: {
        identityType_identityValue: {
          identityType: type,
          identityValue: normalizeSuspectValue(type, value),
        },
      },
      select: { status: true },
    })
    return row?.status === 'ACTIVE'
  },

  async list(q: {
    status?: SuspectStatus
    identityType?: SuspectIdentityType
    q?: string
    userId?: string
    page: number
    limit: number
  }) {
    const where: Prisma.PaymentSuspectWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.identityType && { identityType: q.identityType }),
      ...(q.userId && { userId: q.userId }),
      ...(q.q && { identityValue: { contains: q.q.trim(), mode: 'insensitive' } }),
    }
    const [total, rows] = await Promise.all([
      prismaRead.paymentSuspect.count({ where }),
      prismaRead.paymentSuspect.findMany({
        where,
        orderBy: [{ lastFlaggedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ])
    return {
      items: rows.map((r) => ({
        id: r.id,
        identityType: r.identityType,
        identityValue: r.identityValue,
        userId: r.userId,
        reason: r.reason,
        sourceTxnId: r.sourceTxnId,
        status: r.status,
        hitCount: r.hitCount,
        note: r.note,
        lastFlaggedAt: r.lastFlaggedAt.toISOString(),
        clearedAt: r.clearedAt?.toISOString() ?? null,
        clearedByAdminId: r.clearedByAdminId,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page: q.page,
      limit: q.limit,
    }
  },

  /**
   * Clear (or re-activate) one entry. Clearing does NOT lift the account suspension: the admin
   * reactivates the user separately (user detail → status), on purpose.
   */
  async setStatus(params: {
    id: string
    status: SuspectStatus
    note?: string
    adminUserId: string
  }) {
    const existing = await prisma.paymentSuspect.findUnique({ where: { id: params.id } })
    if (!existing) throw new AppError(404, 'Suspect entry not found', 'NOT_FOUND')
    const row = await prisma.paymentSuspect.update({
      where: { id: params.id },
      data: {
        status: params.status,
        ...(params.note !== undefined && { note: params.note }),
        clearedAt: params.status === 'CLEARED' ? new Date() : null,
        clearedByAdminId: params.status === 'CLEARED' ? params.adminUserId : null,
      },
    })
    return { id: row.id, status: row.status, note: row.note }
  },
}
