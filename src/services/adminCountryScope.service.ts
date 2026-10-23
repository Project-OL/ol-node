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
 *  - lists of many users' money or data (transactions, payroll, user search/history/stats) are
 *    filtered (BE-24): `enforce` returns the admin's countries, `authenticateAdmin` puts them on
 *    `request.adminCountryScope`, and the list keeps only rows whose every user is in them;
 *  - company-finance aggregates (ledger, ledger audit, profit summary, payroll config) can't be
 *    split by user country and are refused.
 * Admins with no grants and SUPER_ADMIN are unaffected. An id that resolves to nothing passes
 * through, so the handler still answers its usual 404/400.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Admin-relative lists ("/admin/...") that filter themselves by `request.adminCountryScope`. */
const COUNTRY_FILTERED_LISTS: RegExp[] = [
  /^\/admin\/transactions\/(coins|points|trading-coins|game-diamonds|coin-trading-transfers|gifts|subscriptions|vip-purchases|store-purchases)$/,
  /^\/admin\/agency\/payroll\/(assignments|disputed|pending-platform)$/,
  /^\/admin\/users\/(search|search\/history|stats)$/,
]

/** Company-wide finance views: refused to country-restricted admins. */
const COMPANY_FINANCE_ROUTES: RegExp[] = [
  /^\/admin\/transactions(\/|$)/,
  /^\/admin\/ledger(\/|$)/,
  /^\/admin\/ledger-audit(\/|$)/,
  /^\/admin\/agency\/payroll(\/|$)/,
]

/** Prisma filter for a user relation inside the admin's countries. */
export const inCountries = (countries: string[]) => ({ country: { in: countries } })

/** Keeps the users (by `userId`) whose country is in `countries`; unchanged when no scope. */
export async function keepUsersInCountries<T extends { userId: string }>(
  users: T[],
  countries: string[] | undefined,
): Promise<T[]> {
  if (!countries || users.length === 0) return users
  const rows = await prismaRead.user.findMany({
    where: { id: { in: users.map((u) => u.userId) }, ...inCountries(countries) },
    select: { id: true },
  })
  const ok = new Set(rows.map((r) => r.id))
  return users.filter((u) => ok.has(u.userId))
}

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
   * @returns the admin's countries when the route is a country-filtered list (the caller puts
   *   them on `request.adminCountryScope`), else undefined
   */
  async enforce(
    adminId: string,
    role: AdminRole,
    route: string,
    params: Params,
  ): Promise<string[] | undefined> {
    if (role === 'SUPER_ADMIN') return undefined
    const access = await adminCountryAccessService.getAccessSnapshot(adminId)
    if (!access.restricted) return undefined

    const users = await resolveRouteUsers(route, params)
    if (users === null) {
      if (COUNTRY_FILTERED_LISTS.some((re) => re.test(route))) return [...access.countries]
      if (COMPANY_FINANCE_ROUTES.some((re) => re.test(route))) {
        throw new AppError(
          403,
          'This view is not available to country-restricted admins',
          'COUNTRY_ACCESS_FORBIDDEN',
        )
      }
      return undefined
    }
    if (!users.length) return undefined
    const rows = await prismaRead.user.findMany({
      where: { id: { in: users } },
      select: { id: true, country: true },
    })
    const country = new Map(rows.map((r) => [r.id, r.country]))
    for (const id of users) {
      if (!country.has(id)) continue
      await adminCountryAccessService.assertAllowed(adminId, role, country.get(id) ?? null)
    }
    return undefined
  },
}
