import { redisClient, RedisKeys } from '../config/redis'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { supportRepository } from '../repositories/support.repository'
import { systemAdminService } from './systemAdmin.service'
import { supportAssignmentService } from './supportAssignment.service'
import { AppError } from '../middlewares/errorHandler'
import { toCsv } from '../utils/csv'
import type {
  CreateCsaInput,
  UpdateCsaInput,
  ListCsasQuery,
  FailedLoginsQuery,
  FailedLoginAttemptsQuery,
  CsaTicketsQuery,
  AddCsaIpInput,
} from '../models/csa-admin.schemas'
import { adminLoginFailureRepository } from '../repositories/adminLoginFailure.repository'
import type { AdminStatus, SupportTicketStatus, SystemAdmin } from '@prisma/client'
import { enrichAdminTicket } from './supportAdmin.service'
import { normalizeCountry, normalizeCountryOptional } from '../utils/agency-country'

const EXPORT_ROW_CAP = 10_000

type CsaRow = ReturnType<typeof toCsaDto> & {
  isOnline: boolean
  openTicketCount: number
  closedTicketCount: number
  avgRating: number | null
  ratingCount: number
  failedAttemptCount24h: number
}

function toCsaDto(admin: SystemAdmin) {
  return {
    id: admin.id,
    name: admin.displayName,
    username: admin.username,
    email: admin.email,
    phone: admin.phone,
    phoneCountryCode: admin.phoneCountryCode,
    gender: admin.gender,
    country: admin.country,
    status: admin.status,
    role: admin.role,
    createdAt: admin.createdAt,
    lastLoginAt: admin.lastLoginAt,
    failedLoginCount: admin.failedLoginCount,
    lastFailedLoginAt: admin.lastFailedLoginAt,
    lockedUntil: admin.lockedUntil,
    /** True while lockedUntil is in the future (login lockout, not DISABLED/SUSPENDED). */
    isLocked: admin.lockedUntil != null && admin.lockedUntil.getTime() > Date.now(),
  }
}

function toIpDto(row: { id: string; ipAddress: string; createdAt: Date; createdByAdminId: string | null }) {
  return {
    id: row.id,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
    createdByAdminId: row.createdByAdminId,
  }
}

async function onlineFlags(adminIds: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>()
  if (adminIds.length === 0) return map
  try {
    const values = await redisClient.mget(adminIds.map((id) => RedisKeys.adminOnline(id)))
    adminIds.forEach((id, i) => map.set(id, values[i] !== null))
  } catch {
    adminIds.forEach((id) => map.set(id, false))
  }
  return map
}

async function findCsaOrThrow(adminId: string) {
  const admin = await systemAdminRepository.findById(adminId)
  if (!admin || admin.role !== 'CUSTOMER_SUPPORT') {
    throw new AppError(404, 'Customer support user not found', 'CSA_NOT_FOUND')
  }
  return admin
}

export const csaManagementService = {
  /** 404 CSA_NOT_FOUND unless adminId is an existing CUSTOMER_SUPPORT admin. */
  async assertCsa(adminId: string) {
    await findCsaOrThrow(adminId)
  },

  async createCsa(input: CreateCsaInput, createdByAdminId?: string) {
    const uniqueIps = [...new Set(input.allowedIps)]
    const admin = await systemAdminService.createAdmin({
      email: input.email,
      password: input.password,
      displayName: input.name,
      role: 'CUSTOMER_SUPPORT',
      username: input.username,
      phone: input.phone,
      phoneCountryCode: input.phoneCountryCode,
      gender: input.gender ?? null,
      country: normalizeCountry(input.country),
    })

    await systemAdminRepository.addIpWhitelistMany(
      uniqueIps.map((ipAddress) => ({
        adminId: admin.id,
        ipAddress,
        createdByAdminId: createdByAdminId ?? null,
      })),
    )

    const ipWhitelist = await systemAdminRepository.listIpWhitelist(admin.id)
    return { ...toCsaDto(admin), ipWhitelist: ipWhitelist.map(toIpDto) }
  },

  async listCsas(query: ListCsasQuery) {
    const { items, total } = await systemAdminRepository.findMany({
      role: 'CUSTOMER_SUPPORT',
      status: query.status,
      country: query.country,
      search: query.search,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    })

    const ids = items.map((a) => a.id)
    const since24h = new Date(Date.now() - 24 * 3600_000)
    const [online, openLoads, closedLoads, ratingStats, attemptCounts] = await Promise.all([
      onlineFlags(ids),
      supportRepository.countOpenByAdminIds(ids),
      supportRepository.countClosedByAdminIds(ids),
      supportRepository.ratingStatsByAdminIds(ids),
      adminLoginFailureRepository.countByAdminIdsSince(ids, since24h),
    ])

    const csas: CsaRow[] = items.map((a) => {
      const ratings = ratingStats.get(a.id)
      return {
        ...toCsaDto(a),
        isOnline: online.get(a.id) ?? false,
        openTicketCount: openLoads.get(a.id) ?? 0,
        closedTicketCount: closedLoads.get(a.id) ?? 0,
        avgRating: ratings?.avgRating ?? null,
        ratingCount: ratings?.ratingCount ?? 0,
        failedAttemptCount24h: attemptCounts.get(a.id) ?? 0,
      }
    })

    return {
      csas,
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    }
  },

  /**
   * Unpaginated ACTIVE CSA picker for ticket hand-off / queue filters.
   * Omits emails, phones, lockout stats — unlike SUPER_ADMIN `listCsas`.
   */
  async listDirectory() {
    const rows = await systemAdminRepository.findAllByRole('CUSTOMER_SUPPORT', 'ACTIVE')
    const csas = rows
      .map((a) => ({
        id: a.id,
        name: a.displayName,
        username: a.username,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { csas }
  },

  async getCsa(adminId: string) {
    const admin = await findCsaOrThrow(adminId)
    const [online, performance, ipWhitelist] = await Promise.all([
      onlineFlags([adminId]),
      supportRepository.csaPerformance(adminId),
      systemAdminRepository.listIpWhitelist(adminId),
    ])
    return {
      ...toCsaDto(admin),
      isOnline: online.get(adminId) ?? false,
      performance,
      ipWhitelist: ipWhitelist.map(toIpDto),
    }
  },

  async listIpWhitelist(adminId: string) {
    await findCsaOrThrow(adminId)
    const items = await systemAdminRepository.listIpWhitelist(adminId)
    return { adminId, ips: items.map(toIpDto) }
  },

  async addIp(adminId: string, input: AddCsaIpInput, createdByAdminId: string) {
    await findCsaOrThrow(adminId)
    const count = await systemAdminRepository.countIpWhitelist(adminId)
    if (count >= 20) {
      throw new AppError(400, 'Maximum of 20 whitelisted IPs per CSA', 'CSA_IP_LIMIT')
    }
    const existing = await systemAdminRepository.findIpWhitelistByAddress(adminId, input.ipAddress)
    if (existing) {
      throw new AppError(409, 'IP already whitelisted for this CSA', 'CSA_IP_CONFLICT')
    }
    const row = await systemAdminRepository.addIpWhitelist({
      adminId,
      ipAddress: input.ipAddress,
      createdByAdminId,
    })
    return toIpDto(row)
  },

  async removeIp(adminId: string, whitelistId: string) {
    await findCsaOrThrow(adminId)
    const row = await systemAdminRepository.findIpWhitelistEntry(adminId, whitelistId)
    if (!row) {
      throw new AppError(404, 'Whitelisted IP not found', 'CSA_IP_NOT_FOUND')
    }
    await systemAdminRepository.removeIpWhitelist(whitelistId)
    return { ok: true as const, id: whitelistId }
  },

  async updateCsa(adminId: string, input: UpdateCsaInput) {
    const admin = await findCsaOrThrow(adminId)
    if (input.username && input.username !== admin.username) {
      const taken = await systemAdminRepository.findByUsername(input.username)
      if (taken) throw new AppError(409, 'Username already taken', 'ADMIN_USERNAME_CONFLICT')
    }

    const updated = await systemAdminRepository.update(adminId, {
      ...(input.name !== undefined ? { displayName: input.name } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.phoneCountryCode !== undefined ? { phoneCountryCode: input.phoneCountryCode } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.country !== undefined
        ? { country: normalizeCountryOptional(input.country) }
        : {}),
    })
    return toCsaDto(updated)
  },

  async setStatus(adminId: string, status: AdminStatus) {
    const admin = await findCsaOrThrow(adminId)
    if (admin.status === status) {
      return { ...toCsaDto(admin), reassignment: null }
    }

    const updated = await systemAdminRepository.setStatus(adminId, status)

    let reassignment: { reassigned: number; unassigned: number } | null = null
    if (status !== 'ACTIVE') {
      // Kick the CSA out immediately and hand their open tickets to peers.
      await systemAdminService.logout(adminId).catch(() => null)
      reassignment = await supportAssignmentService.reassignAllFrom(adminId)
    }

    console.warn('[csa-management] status changed', { adminId, status, reassignment })
    return { ...toCsaDto(updated), reassignment }
  },

  async exportCsasCsv(status?: AdminStatus) {
    const rows = await systemAdminRepository.findAllByRole('CUSTOMER_SUPPORT', status)
    if (rows.length > EXPORT_ROW_CAP) {
      throw new AppError(413, 'Export too large — narrow the filter', 'EXPORT_TOO_LARGE')
    }
    const csv = toCsv(
      rows.map((a) => ({
        name: a.displayName,
        username: a.username,
        email: a.email,
        phoneCountryCode: a.phoneCountryCode,
        phone: a.phone,
        gender: a.gender,
        country: a.country,
        status: a.status,
        createdAt: a.createdAt,
        lastLoginAt: a.lastLoginAt,
        failedLoginCount: a.failedLoginCount,
      })),
      [
        { key: 'name', header: 'Name' },
        { key: 'username', header: 'Username' },
        { key: 'email', header: 'Email' },
        { key: 'phoneCountryCode', header: 'Phone Country Code' },
        { key: 'phone', header: 'Phone' },
        { key: 'gender', header: 'Gender' },
        { key: 'country', header: 'Country' },
        { key: 'status', header: 'Status' },
        { key: 'createdAt', header: 'Created At' },
        { key: 'lastLoginAt', header: 'Last Login At' },
        { key: 'failedLoginCount', header: 'Failed Login Count' },
      ],
    )
    return { csv, count: rows.length }
  },

  async getOverviewStats() {
    const [byStatus, allCsas, failedLoginAttempts24h, failedLogins] = await Promise.all([
      systemAdminRepository.countByRoleAndStatus('CUSTOMER_SUPPORT'),
      systemAdminRepository.findAllByRole('CUSTOMER_SUPPORT'),
      adminLoginFailureRepository.countSince(new Date(Date.now() - 24 * 3600_000), 'CUSTOMER_SUPPORT'),
      systemAdminRepository.aggregateFailedLogins(
        'CUSTOMER_SUPPORT',
        new Date(Date.now() - 24 * 3600_000),
      ),
    ])

    const counts: Record<AdminStatus, number> = { ACTIVE: 0, DISABLED: 0, SUSPENDED: 0 }
    for (const row of byStatus) counts[row.status] = row._count._all

    const online = await onlineFlags(allCsas.map((a) => a.id))
    const onlineNow = [...online.values()].filter(Boolean).length

    return {
      totalCsa: counts.ACTIVE + counts.DISABLED + counts.SUSPENDED,
      activeCsa: counts.ACTIVE,
      onlineNow,
      suspendedCsa: counts.SUSPENDED,
      disabledCsa: counts.DISABLED,
      failedLoginAttempts24h,
      lockedAccounts: failedLogins.lockedAccounts,
    }
  },

  async getCsaStats(adminId: string) {
    await findCsaOrThrow(adminId)
    return supportRepository.csaPerformance(adminId)
  },

  /**
   * Which CSA accounts have recent failed logins / active lockouts — for the
   * security overview so SUPER_ADMIN can suspend/reset the named account.
   */
  async listFailedLogins(query: FailedLoginsQuery) {
    const since = new Date(Date.now() - query.withinHours * 3600_000)
    const skip = (query.page - 1) * query.limit
    const { items, total } = await systemAdminRepository.findFailedLoginAccounts(
      'CUSTOMER_SUPPORT',
      { since, includeLocked: query.includeLocked, skip, take: query.limit },
    )
    const online = await onlineFlags(items.map((a) => a.id))
    const attemptCounts = await adminLoginFailureRepository.countByAdminIdsSince(
      items.map((a) => a.id),
      since,
    )
    return {
      withinHours: query.withinHours,
      accounts: items.map((a) => ({
        ...toCsaDto(a),
        isOnline: online.get(a.id) ?? false,
        failedAttemptCount: attemptCounts.get(a.id) ?? 0,
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: skip + items.length < total,
    }
  },

  async listFailedLoginAttempts(query: FailedLoginAttemptsQuery) {
    if (query.adminId) await findCsaOrThrow(query.adminId)
    const since = new Date(Date.now() - query.withinHours * 3600_000)
    const skip = (query.page - 1) * query.limit
    const { items, total } = await adminLoginFailureRepository.list({
      since,
      role: 'CUSTOMER_SUPPORT',
      adminId: query.adminId,
      skip,
      take: query.limit,
    })
    return {
      withinHours: query.withinHours,
      attempts: items.map((row) => ({
        id: row.id,
        adminId: row.adminId,
        email: row.admin.email,
        name: row.admin.displayName,
        reason: row.reason,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasMore: skip + items.length < total,
    }
  },

  /**
   * All tickets assigned to a CSA (or closed/rated subset) plus performance
   * averages — power the per-CSA ratings & ticket roster screens.
   */
  async listCsaTickets(adminId: string, query: CsaTicketsQuery) {
    await findCsaOrThrow(adminId)
    const skip = (query.page - 1) * query.limit
    const status = query.status as SupportTicketStatus | undefined
    const [{ tickets, total }, performance] = await Promise.all([
      supportRepository.findAdminTickets({
        assignedAdminId: adminId,
        status: query.ratedOnly ? 'CLOSED' : status,
        ratedOnly: query.ratedOnly,
        skip,
        take: query.limit,
      }),
      supportRepository.csaPerformance(adminId),
    ])

    const payload = {
      adminId,
      avgRating: performance.avgRating,
      ratingCount: performance.ratingCount,
      tickets: await Promise.all(tickets.map((t) => enrichAdminTicket(t))),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + tickets.length < total,
      },
    }
    return JSON.parse(
      JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ) as typeof payload
  },
}
