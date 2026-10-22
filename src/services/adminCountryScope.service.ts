import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { adminCountryAccessService } from './adminCountryAccess.service'
import type { AdminRole } from '@prisma/client'

/**
 * F05: a country-restricted admin (>=1 granted country, not SUPER_ADMIN) may read or change only
 * users of those countries. Enforced centrally in `authenticateAdmin`, after the view gate, from
 * the route's params:
 *  - user-scoped routes (`:userId`, a withdrawal, payroll assignment, ledger entry, gift,
 *    coin-trading transfer or agency) resolve every user the route touches; each must be in a
 *    granted country (`adminCountryAccessService.assertAllowed`);
 *  - global lists of money and personal data (transactions, ledger, payroll, user search/stats)
 *    are refused for now (follow-up: filter them by the admin's countries instead).
 * Admins with no grants and SUPER_ADMIN are unaffected. An id that resolves to nothing passes
 * through, so the handler still answers its usual 404/400.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Admin-relative route patterns ("/admin/...") whose responses span many users' money or data. */
const GLOBAL_SENSITIVE_LISTS: RegExp[] = [
  /^\/admin\/transactions(\/|$)/,
  /^\/admin\/ledger(\/|$)/,
  /^\/admin\/ledger-audit(\/|$)/,
  /^\/admin\/agency\/payroll(\/|$)/,
  /^\/admin\/users\/(search|stats)(\/|$)/,
]

type Params = Record<string, string | undefined>

async function userIdFromIdentifier(identifier: string): Promise<string | null> {
  const trimmed = identifier.trim().replace(/^#/, '')
  if (UUID_RE.test(trimmed)) return trimmed
  if (!/^\d{1,18}$/.test(trimmed)) return null
  const pid = BigInt(trimmed)
  const user = await prismaRead.user.findFirst({
    where: { OR: [{ publicId: pid }, { defaultPublicId: pid }, { currentVipPublicId: pid }] },
    select: { id: true },
  })
  return user?.id ?? null
}

async function agencyUserId(identifier: string): Promise<string | null> {
  const trimmed = identifier.trim()
  if (UUID_RE.test(trimmed)) return trimmed
  if (!/^\d{1,18}$/.test(trimmed)) return null
  const agency = await prismaRead.agency.findUnique({
    where: { defaultPublicId: BigInt(trimmed) },
    select: { userId: true },
  })
  return agency?.userId ?? null
}

const uuidOrNull = (v: string | undefined) => (v && UUID_RE.test(v) ? v : null)

/**
 * Users a route acts on, from its params. `null` = the route is not user-scoped; `[]` = it is,
 * but the id resolves to nothing (the handler will 404).
 */
export async function resolveRouteUsers(route: string, params: Params): Promise<string[] | null> {
  const ids: (string | null | undefined)[] = []
  let scoped = false

  if (params.userId) {
    scoped = true
    ids.push(await userIdFromIdentifier(params.userId))
  }
  if (params.agencyIdentifier) {
    scoped = true
    ids.push(await agencyUserId(params.agencyIdentifier))
  }
  if (params.id && /^\/admin\/agency\/withdrawal\/:id(\/|$)/.test(route)) {
    scoped = true
    const id = uuidOrNull(params.id)
    const w = id
      ? await prismaRead.withdrawal.findUnique({ where: { id }, select: { userId: true } })
      : null
    ids.push(w?.userId)
  }
  if (params.assignmentId) {
    scoped = true
    const id = uuidOrNull(params.assignmentId)
    const a = id
      ? await prismaRead.withdrawalPayrollAssignment.findUnique({
          where: { id },
          select: { agencyUserId: true, withdrawal: { select: { userId: true } } },
        })
      : null
    ids.push(a?.withdrawal.userId, a?.agencyUserId)
  }
  if (params.ledgerEntryId) {
    scoped = true
    const id = uuidOrNull(params.ledgerEntryId)
    const select = { counterpartyId: true, wallet: { select: { userId: true } } } as const
    const e = !id
      ? null
      : route.startsWith('/admin/transactions/coins/')
        ? await prismaRead.coinLedgerEntry.findUnique({ where: { id }, select })
        : await prismaRead.pointLedgerEntry.findUnique({ where: { id }, select })
    ids.push(e?.wallet.userId, e?.counterpartyId)
  }
  if (params.giftTransactionId) {
    scoped = true
    const id = uuidOrNull(params.giftTransactionId)
    const g = id
      ? await prismaRead.giftTransaction.findUnique({
          where: { id },
          select: { senderUserId: true, receiverUserId: true },
        })
      : null
    ids.push(g?.senderUserId, g?.receiverUserId)
  }
  if (params.transferId) {
    scoped = true
    const id = uuidOrNull(params.transferId)
    const t = id
      ? await prismaRead.coinTradingTransfer.findUnique({
          where: { id },
          select: { senderAgentUserId: true, recipientUserId: true },
        })
      : null
    ids.push(t?.senderAgentUserId, t?.recipientUserId)
  }

  if (!scoped) return null
  return [...new Set(ids.filter((v): v is string => typeof v === 'string'))]
}

export const adminCountryScopeService = {
  /**
   * @param route admin-relative registered route, e.g. "/admin/users/:userId/wallet"
   */
  async enforce(adminId: string, role: AdminRole, route: string, params: Params): Promise<void> {
    if (role === 'SUPER_ADMIN') return
    const access = await adminCountryAccessService.getAccessSnapshot(adminId)
    if (!access.restricted) return

    const users = await resolveRouteUsers(route, params)
    if (users === null) {
      if (GLOBAL_SENSITIVE_LISTS.some((re) => re.test(route))) {
        throw new AppError(
          403,
          'This list is not available to country-restricted admins',
          'COUNTRY_ACCESS_FORBIDDEN',
        )
      }
      return
    }
    if (!users.length) return
    const rows = await prismaRead.user.findMany({
      where: { id: { in: users } },
      select: { id: true, country: true },
    })
    const country = new Map(rows.map((r) => [r.id, r.country]))
    for (const id of users) {
      if (!country.has(id)) continue
      await adminCountryAccessService.assertAllowed(adminId, role, country.get(id) ?? null)
    }
  },
}
