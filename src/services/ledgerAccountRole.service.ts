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
  /** Union of both — the set excluded from customer float. */
  allIds: Set<string>
}

type CachedHouseAccounts = {
  treasury: string[]
  companyAgency: string[]
}

function buildSets(dto: CachedHouseAccounts): HouseAccounts {
  const treasuryIds = new Set(dto.treasury)
  const companyAgencyIds = new Set(dto.companyAgency)
  return {
    treasuryIds,
    companyAgencyIds,
    allIds: new Set([...treasuryIds, ...companyAgencyIds]),
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
  const dto: CachedHouseAccounts = { treasury: [], companyAgency: [] }
  for (const r of rows) {
    if (r.role === LedgerAccountRoleType.TREASURY) dto.treasury.push(r.userId)
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
async function userBalances(
  userId: string,
): Promise<{ currency: string; balance: bigint }[]> {
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
    // Treasury sells via the agent trading-transfer rail, which requires is_agent.
    if (!user.isAgent) {
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
   * Deactivate a role. Refused while the account still holds units, because the
   * balance would silently reappear as a customer liability and break the
   * float-reconciliation identity.
   */
  async deactivate(params: { userId: string; force?: boolean }) {
    const existing = await ledgerAccountRoleRepository.findByUserId(params.userId)
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

    await ledgerAccountRoleRepository.deactivate(params.userId)
    await this.bustCache()
    return { ok: true as const, userId: params.userId }
  },
}
