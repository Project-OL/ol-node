import { LedgerAccountRoleType, Prisma } from '@prisma/client'
import { LEDGER_HOUSE_ACCOUNTS_TTL, RedisKeys, redisClient } from '../config/redis'
import { prismaRead } from '../config/database'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import {
  ledgerAccountRoleRepository,
  type LedgerAccountRoleRow,
} from '../repositories/ledgerAccountRole.repository'
import { buildUserDisplayName, formatUserName } from '../utils/user-display'
import { unitsToUsd } from '../utils/points-currency'

/**
 * Resolved house-account registry.
 * `treasury` sells units; `companyAgency` absorbs BANK payroll takeover inventory.
 * Both are house (non-liability) accounts for master-ledger reporting.
 */
export type HouseAccounts = {
  treasuryIds: Set<string>
  companyAgencyIds: Set<string>
  /** DIAMOND-wallet counterparty for game wager/payout/refund settlement. */
  gameHouseIds: Set<string>
  /** Union of all roles — the set excluded from customer float. */
  allIds: Set<string>
}

type CachedHouseAccounts = {
  treasury: string[]
  companyAgency: string[]
  gameHouse: string[]
}

function buildSets(dto: CachedHouseAccounts): HouseAccounts {
  const treasuryIds = new Set(dto.treasury)
  const companyAgencyIds = new Set(dto.companyAgency)
  const gameHouseIds = new Set(dto.gameHouse ?? [])
  return {
    treasuryIds,
    companyAgencyIds,
    gameHouseIds,
    allIds: new Set([...treasuryIds, ...companyAgencyIds, ...gameHouseIds]),
  }
}

/**
 * `COMPANY_AGENCY_USER_ID` predates the role table. Keep honouring it so a
 * half-migrated deployment still classifies the takeover account as house.
 */
function withEnvFallback(dto: CachedHouseAccounts): CachedHouseAccounts {
  const envId = env.COMPANY_AGENCY_USER_ID?.trim()
  if (!envId) return dto
  if (dto.companyAgency.includes(envId) || dto.treasury.includes(envId)) return dto
  return { ...dto, companyAgency: [...dto.companyAgency, envId] }
}

async function loadFromDb(): Promise<CachedHouseAccounts> {
  const rows = await ledgerAccountRoleRepository.listActiveRoles()
  const dto: CachedHouseAccounts = { treasury: [], companyAgency: [], gameHouse: [] }
  for (const r of rows) {
    if (r.role === LedgerAccountRoleType.TREASURY) dto.treasury.push(r.userId)
    else if (r.role === LedgerAccountRoleType.GAME_HOUSE) dto.gameHouse.push(r.userId)
    else dto.companyAgency.push(r.userId)
  }
  return withEnvFallback(dto)
}

function mapRow(row: LedgerAccountRoleRow) {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    label: row.label,
    isActive: row.isActive,
    effectiveFrom: row.effectiveFrom.toISOString(),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    user: {
      userId: row.user.id,
      username: row.user.username,
      name: formatUserName(row.user),
      displayName: buildUserDisplayName(row.user),
      publicId: row.user.publicId.toString(),
      isAgent: row.user.isAgent,
      avatarUrl: row.user.avatarUrl,
    },
  }
}

/** Latest ledger balance per wallet for one user (all currencies). */
async function userBalances(userId: string): Promise<{ currency: string; balance: bigint }[]> {
  const rows = await prismaRead.$queryRaw<{ currency: string; balance: bigint }[]>(Prisma.sql`
    SELECT w.currency_type::text AS currency,
           COALESCE(c.balance_after, p.balance_after, 0) AS balance
    FROM wallets w
    LEFT JOIN LATERAL (
      SELECT balance_after FROM coin_ledger_entries
      WHERE wallet_id = w.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) c ON w.currency_type <> 'POINT'
    LEFT JOIN LATERAL (
      SELECT balance_after FROM point_ledger_entries
      WHERE wallet_id = w.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) p ON w.currency_type = 'POINT'
    WHERE w.user_id = ${userId}::uuid
  `)
  return rows.map((r) => ({ currency: r.currency, balance: BigInt(r.balance ?? 0) }))
}

export const ledgerAccountRoleService = {
  /** Cached house-account id sets. Read on every ledger aggregation. */
  async getHouseAccounts(): Promise<HouseAccounts> {
    const key = RedisKeys.ledgerHouseAccounts()
    try {
      const hit = await redisClient.get(key)
      if (hit) return buildSets(JSON.parse(hit) as CachedHouseAccounts)
    } catch {
      /* cache miss or Redis down — fall through to DB */
    }

    const dto = await loadFromDb()
    try {
      await redisClient.set(key, JSON.stringify(dto), 'EX', LEDGER_HOUSE_ACCOUNTS_TTL)
    } catch {
      /* ignore */
    }
    return buildSets(dto)
  },

  /**
   * The single active GAME_HOUSE account id — the counterparty for every diamond
   * wager/payout/refund. Throws a config error rather than silently settling
   * against no one; an admin must provision this via `POST /admin/system-settings/
   * ledger-account-roles` (role=GAME_HOUSE) before any game can go live.
   */
  async requireGameHouseUserId(): Promise<string> {
    const { gameHouseIds } = await this.getHouseAccounts()
    const [first] = gameHouseIds
    if (!first) {
      throw new AppError(
        500,
        'No active GAME_HOUSE ledger account configured',
        'GAME_HOUSE_NOT_CONFIGURED',
      )
    }
    return first
  },

  async bustCache(): Promise<void> {
    try {
      await redisClient.del(RedisKeys.ledgerHouseAccounts())
    } catch {
      /* ignore */
    }
  },

  async list(includeInactive: boolean) {
    const rows = await ledgerAccountRoleRepository.listAll(includeInactive)
    const envId = env.COMPANY_AGENCY_USER_ID?.trim() || null
    return {
      accounts: rows.map(mapRow),
      /** Surfaced so admins can see an env-configured account not yet migrated into the table. */
      envCompanyAgencyUserId: envId,
      envFallbackActive: Boolean(envId && !rows.some((r) => r.userId === envId && r.isActive)),
    }
  },

  async upsert(params: {
    adminUserId: string
    userId: string
    role: LedgerAccountRoleType
    label?: string
    note?: string
    effectiveFrom?: Date
  }) {
    const user = await prismaRead.user.findUnique({
      where: { id: params.userId },
      select: { id: true, isAgent: true, status: true },
    })
    if (!user || user.status === 'deleted') {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }
    // Treasury/company-agency sell via the agent trading-transfer rail, which requires
    // is_agent. GAME_HOUSE only settles DIAMOND wallets internally — no peer coin rail,
    // so it's exempt.
    if (params.role !== LedgerAccountRoleType.GAME_HOUSE && !user.isAgent) {
      throw new AppError(
        400,
        'House accounts must be agency agents so they can send trading coins',
        'HOUSE_ACCOUNT_NOT_AGENT',
      )
    }

    const row = await ledgerAccountRoleRepository.upsert({
      userId: params.userId,
      role: params.role,
      label: params.label ?? null,
      note: params.note ?? null,
      effectiveFrom: params.effectiveFrom,
      createdByAdminId: params.adminUserId,
    })
    await this.bustCache()
    return mapRow(row)
  },

  /**
   * Deactivate one role held by a user. Refused while the account still holds
   * units, because the balance would silently reappear as a customer liability
   * and break the float-reconciliation identity. A user can hold more than one
   * role (e.g. TREASURY + GAME_HOUSE) — `role` says which one to remove; if
   * omitted it only works when the user holds exactly one.
   */
  async deactivate(params: { userId: string; role?: LedgerAccountRoleType; force?: boolean }) {
    const roles = await ledgerAccountRoleRepository.findAllByUserId(params.userId)
    if (!params.role && roles.length > 1) {
      throw new AppError(
        400,
        'User holds more than one role — specify which one to remove',
        'MULTIPLE_ROLES_SPECIFY_ONE',
      )
    }
    const existing = params.role
      ? roles.find((r) => r.role === params.role)
      : roles[0]
    if (!existing) throw new AppError(404, 'House account role not found', 'ROLE_NOT_FOUND')

    if (!params.force) {
      const balances = await userBalances(params.userId)
      const held = balances.filter((b) => b.balance !== 0n)
      if (held.length > 0) {
        const total = held.reduce((acc, b) => acc + b.balance, 0n)
        throw new AppError(
          409,
          `Account still holds ${total.toString()} units ($${unitsToUsd(total)}). Drain or return the balance first, or pass force=true.`,
          'HOUSE_ACCOUNT_HAS_BALANCE',
        )
      }
    }

    await ledgerAccountRoleRepository.deactivate(params.userId, existing.role)
    await this.bustCache()
    return { ok: true as const, userId: params.userId, role: existing.role }
  },
}
