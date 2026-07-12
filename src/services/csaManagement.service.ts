import { redisClient, RedisKeys } from '../config/redis'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { supportRepository } from '../repositories/support.repository'
import { systemAdminService } from './systemAdmin.service'
import { supportAssignmentService } from './supportAssignment.service'
import { AppError } from '../middlewares/errorHandler'
import { toCsv } from '../utils/csv'
import type { CreateCsaInput, UpdateCsaInput, ListCsasQuery } from '../models/csa-admin.schemas'
import type { AdminStatus, SystemAdmin } from '@prisma/client'

const EXPORT_ROW_CAP = 10_000

type CsaRow = ReturnType<typeof toCsaDto> & { isOnline: boolean; openTicketCount: number }

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
    lockedUntil: admin.lockedUntil,
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
  async createCsa(input: CreateCsaInput) {
    const admin = await systemAdminService.createAdmin({
      email: input.email,
      password: input.password,
      displayName: input.name,
      role: 'CUSTOMER_SUPPORT',
      username: input.username,
      phone: input.phone,
      phoneCountryCode: input.phoneCountryCode,
      gender: input.gender ?? null,
      country: input.country,
    })
    return toCsaDto(admin)
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
    const [online, loads] = await Promise.all([
      onlineFlags(ids),
      supportRepository.countOpenByAdminIds(ids),
    ])

    const csas: CsaRow[] = items.map((a) => ({
      ...toCsaDto(a),
      isOnline: online.get(a.id) ?? false,
      openTicketCount: loads.get(a.id) ?? 0,
    }))

    return {
      csas,
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    }
  },

  async getCsa(adminId: string) {
    const admin = await findCsaOrThrow(adminId)
    const [online, performance] = await Promise.all([
      onlineFlags([adminId]),
      supportRepository.csaPerformance(adminId),
    ])
    return {
      ...toCsaDto(admin),
      isOnline: online.get(adminId) ?? false,
      performance,
    }
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
      ...(input.country !== undefined ? { country: input.country } : {}),
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
    const [byStatus, allCsas, failedLogins] = await Promise.all([
      systemAdminRepository.countByRoleAndStatus('CUSTOMER_SUPPORT'),
      systemAdminRepository.findAllByRole('CUSTOMER_SUPPORT'),
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
      failedLoginAttempts24h: failedLogins.failedLoginAttempts,
      lockedAccounts: failedLogins.lockedAccounts,
    }
  },

  async getCsaStats(adminId: string) {
    await findCsaOrThrow(adminId)
    return supportRepository.csaPerformance(adminId)
  },
}
