import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { withdrawalService } from './withdrawal.service'
import { auditService } from './audit.service'
import { withdrawalRepository } from '../repositories/withdrawal.repository'
import { payrollAssignmentRepository } from '../repositories/payrollAssignment.repository'
import { agencyRepository } from '../repositories/agency.repository'
import { storageService } from './storage.service'
import { mapPaymentMethodMaskedForAgent } from '../utils/payment-method-mask'
import { buildUserDisplayName, formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { isAdminWithdrawalRevertable } from '../utils/admin-withdrawal-revert'
import { payrollFeeTierRepository } from '../repositories/payrollFeeTier.repository'
import { usdToPoints, withdrawalHostPayoutPoints } from '../utils/payroll-fee'
import {
  formatLocalAmount,
  resolveLocalFx,
  type PayrollCountryFxDto,
} from '../utils/local-currency'
import { payrollCountryFxRepository } from '../repositories/payrollCountryFx.repository'
import { normalizeCountry } from '../utils/agency-country'

type AdminUserCard = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
  country: string | null
}

function mapUserCard(u: AdminUserCard) {
  const displayName = buildUserDisplayName(u)
  return {
    userId: u.id,
    username: u.username,
    displayName,
    name: formatUserName(u),
    publicId: u.publicId.toString(),
    displayPublicId: resolveDisplayPublicId(u),
    avatarUrl: u.avatarUrl,
    country: u.country,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizePublicId(raw: string): string {
  return raw.trim().replace(/^#/, '')
}

async function resolveAgencyUserId(opts: {
  agencyUserId?: string
  agencyPublicId?: string
}): Promise<string | undefined> {
  if (opts.agencyUserId) {
    if (!UUID_RE.test(opts.agencyUserId)) {
      throw new AppError(400, 'Invalid agencyUserId (UUID expected)', 'INVALID_REQUEST')
    }
    return opts.agencyUserId
  }
  if (!opts.agencyPublicId) return undefined
  const digits = normalizePublicId(opts.agencyPublicId)
  if (!/^\d+$/.test(digits)) {
    throw new AppError(400, 'agencyPublicId must be numeric', 'INVALID_REQUEST')
  }
  const agency = await agencyRepository.getAgencyByPublicId(BigInt(digits))
  if (!agency) throw new AppError(404, 'Agency not found', 'AGENCY_NOT_FOUND')
  return agency.userId
}

async function resolveHostUserId(opts: {
  hostUserId?: string
  hostPublicId?: string
}): Promise<string | undefined> {
  if (opts.hostUserId) {
    if (!UUID_RE.test(opts.hostUserId)) {
      throw new AppError(400, 'Invalid hostUserId (UUID expected)', 'INVALID_REQUEST')
    }
    return opts.hostUserId
  }
  if (!opts.hostPublicId) return undefined
  const digits = normalizePublicId(opts.hostPublicId)
  if (!/^\d+$/.test(digits)) {
    throw new AppError(400, 'hostPublicId must be numeric', 'INVALID_REQUEST')
  }
  const pid = BigInt(digits)
  const host = await prismaRead.user.findFirst({
    where: {
      OR: [{ publicId: pid }, { defaultPublicId: pid }, { currentVipPublicId: pid }],
    },
    select: { id: true },
  })
  if (!host) throw new AppError(404, 'Host not found', 'USER_NOT_FOUND')
  return host.id
}

function mapAdminAssignment(
  row: NonNullable<Awaited<ReturnType<typeof payrollAssignmentRepository.getByIdForAdmin>>>,
  config: { inrPerUsd: number; nprPerUsd?: number; countryRates?: PayrollCountryFxDto[] },
) {
  const w = row.withdrawal
  const hostPayoutUsd = Number(w.hostPayoutUsd ?? 0)
  const platformFeePoints = w.platformFeePoints ?? 0n
  const hostPayoutPoints = withdrawalHostPayoutPoints({
    amountPoints: w.amountPoints,
    platformFeePoints: w.platformFeePoints,
    serviceFeePoints: w.serviceFeePoints,
  })
  const proofKey = row.proofS3Key?.trim() || null
  const local = formatLocalAmount(hostPayoutUsd, resolveLocalFx(w.user.country, config))

  return {
    assignmentId: row.id,
    status: row.status,
    assignmentNumber: row.assignmentNumber,
    assignedAt: row.assignedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    waitingExpiresAt: row.waitingExpiresAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason ?? null,
    /** Proof image / receipt uploaded by agency agent. */
    proofS3Key: proofKey,
    proofImageUrl: proofKey ? storageService.getCdnOrS3PublicUrl(proofKey) : null,
    agent: mapUserCard(row.agencyUser),
    host: mapUserCard(w.user),
    withdrawal: {
      withdrawalId: w.id,
      status: w.status,
      requestedAt: w.requestedAt.toISOString(),
      processedAt: w.processedAt?.toISOString() ?? null,
      disputeTicketId: w.disputeTicketId ?? null,
      assignmentCount: w.assignmentCount,
      /** Gross points withdrawn (escrowed from host). */
      grossPoints: w.amountPoints.toString(),
      /** Platform fee taken from remaining points after the service fee. */
      platformFeePoints: platformFeePoints.toString(),
      /** Points owed / paid to host (= gross − service fee − platform fee). */
      hostPayoutPoints: hostPayoutPoints.toString(),
      hostPayoutUsd: w.hostPayoutUsd?.toString() ?? null,
      localCurrencyAmount: local.localCurrencyAmount,
      localCurrencyCode: local.localCurrencyCode,
      /** Processing reward credited to the agency agent. */
      agentRewardPoints: (w.agentRewardPoints ?? 0n).toString(),
      serviceFeePoints: (w.serviceFeePoints ?? 0n).toString(),
      methodType: w.methodType ?? null,
      payoutHandler: w.payoutHandler ?? null,
      notes: w.notes ?? null,
      /** True when admin may POST `/admin/agency/withdrawal/:id/reverse` (≤4 days from paid + status). */
      canRevert: isAdminWithdrawalRevertable({
        status: w.status,
        processedAt: w.processedAt,
      }),
    },
    paymentMethod: w.paymentMethod ? mapPaymentMethodMaskedForAgent(w.paymentMethod) : null,
  }
}

function parsePointsBound(
  points: string | undefined,
  usd: number | undefined,
  label: string,
): bigint {
  if (points != null && points !== '') {
    if (!/^\d+$/.test(points)) {
      throw new AppError(400, `${label} must be a non-negative integer string`, 'VALIDATION_ERROR')
    }
    return BigInt(points)
  }
  if (usd == null || !Number.isFinite(usd) || usd < 0) {
    throw new AppError(400, `${label} requires minUsd/maxUsd or minPoints/maxPoints`, 'VALIDATION_ERROR')
  }
  return usdToPoints(usd)
}

function normalizeAndValidateFeeTiers(
  input: Array<{
    minUsd?: number
    maxUsd?: number | null
    minPoints?: string
    maxPoints?: string | null
    platformFeeRateBp: number
    agentRewardRateBp: number
  }>,
): Array<{
  minPoints: bigint
  maxPoints: bigint | null
  platformFeeRateBp: number
  agentRewardRateBp: number
}> {
  if (input.length === 0) {
    throw new AppError(400, 'At least one fee tier is required', 'VALIDATION_ERROR')
  }

  const tiers = input.map((row, i) => {
    if (
      !Number.isInteger(row.platformFeeRateBp) ||
      row.platformFeeRateBp < 0 ||
      row.platformFeeRateBp > 10000
    ) {
      throw new AppError(
        422,
        `feeTiers[${i}].platformFeeRateBp must be 0–10000`,
        'INVALID_FEE_CONFIG',
      )
    }
    if (
      !Number.isInteger(row.agentRewardRateBp) ||
      row.agentRewardRateBp < 0 ||
      row.agentRewardRateBp > 10000
    ) {
      throw new AppError(
        422,
        `feeTiers[${i}].agentRewardRateBp must be 0–10000`,
        'INVALID_FEE_CONFIG',
      )
    }
    const minPoints = parsePointsBound(row.minPoints, row.minUsd, `feeTiers[${i}].min`)
    const maxOpen = row.maxPoints == null && (row.maxUsd == null || row.maxUsd === undefined)
    const maxPoints = maxOpen
      ? null
      : parsePointsBound(row.maxPoints ?? undefined, row.maxUsd ?? undefined, `feeTiers[${i}].max`)
    if (maxPoints != null && maxPoints <= minPoints) {
      throw new AppError(
        400,
        `feeTiers[${i}].max must be greater than min`,
        'VALIDATION_ERROR',
      )
    }
    return {
      minPoints,
      maxPoints,
      platformFeeRateBp: row.platformFeeRateBp,
      agentRewardRateBp: row.agentRewardRateBp,
    }
  })

  tiers.sort((a, b) => (a.minPoints < b.minPoints ? -1 : a.minPoints > b.minPoints ? 1 : 0))

  for (let i = 0; i < tiers.length; i++) {
    const cur = tiers[i]!
    const next = tiers[i + 1]
    if (i < tiers.length - 1) {
      if (cur.maxPoints == null) {
        throw new AppError(
          400,
          `feeTiers[${i}] must have a max so the next band can start`,
          'VALIDATION_ERROR',
        )
      }
      if (!next || cur.maxPoints !== next.minPoints) {
        throw new AppError(
          400,
          'Fee tiers must be contiguous (each max equals the next min)',
          'VALIDATION_ERROR',
        )
      }
    } else if (cur.maxPoints != null) {
      throw new AppError(400, 'The last fee tier must be open-ended (max null)', 'VALIDATION_ERROR')
    }
  }

  return tiers
}

function normalizeAndValidateCountryRates(
  input: Array<{
    country: string
    countryCode?: string | null
    currencyCode: string
    ratePerUsd: number
  }>,
): Array<{
  country: string
  countryCode: string | null
  currencyCode: string
  ratePerUsd: Prisma.Decimal
}> {
  if (input.length === 0) {
    throw new AppError(400, 'At least one country rate is required', 'VALIDATION_ERROR')
  }

  const seen = new Set<string>()
  return input.map((row, i) => {
    const country = normalizeCountry(row.country ?? '')
    if (!country) {
      throw new AppError(400, `countryRates[${i}].country is required`, 'VALIDATION_ERROR')
    }
    const countryKey = country.toLowerCase()
    if (seen.has(countryKey)) {
      throw new AppError(400, `Duplicate country "${country}"`, 'VALIDATION_ERROR')
    }
    seen.add(countryKey)

    const currencyCode = (row.currencyCode ?? '').trim().toUpperCase()
    if (!/^[A-Z]{3,8}$/.test(currencyCode)) {
      throw new AppError(
        400,
        `countryRates[${i}].currencyCode must be 3–8 letters`,
        'VALIDATION_ERROR',
      )
    }
    if (!Number.isFinite(row.ratePerUsd) || row.ratePerUsd <= 0) {
      throw new AppError(
        400,
        `countryRates[${i}].ratePerUsd must be a positive number`,
        'VALIDATION_ERROR',
      )
    }
    const rawCode = row.countryCode?.trim() ?? ''
    const countryCode = rawCode ? rawCode.toUpperCase() : null
    if (countryCode && !/^[A-Z]{2,3}$/.test(countryCode)) {
      throw new AppError(
        400,
        `countryRates[${i}].countryCode must be a 2–3 letter ISO code`,
        'VALIDATION_ERROR',
      )
    }
    return {
      country,
      countryCode,
      currencyCode,
      ratePerUsd: new Prisma.Decimal(row.ratePerUsd),
    }
  })
}

function pickLegacyRate(
  rows: Array<{ country: string; countryCode: string | null; currencyCode: string; ratePerUsd: Prisma.Decimal }>,
  match: { countries: string[]; codes: string[]; currency: string },
): Prisma.Decimal | undefined {
  const hit = rows.find(
    (r) =>
      r.currencyCode === match.currency ||
      match.countries.includes(r.country.toLowerCase()) ||
      (r.countryCode != null && match.codes.includes(r.countryCode)),
  )
  return hit?.ratePerUsd
}

export const payrollAdminService = {
  getConfig() {
    return withdrawalService.getPayrollConfig()
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      platformFeeRateBp?: number
      agentRewardRateBp?: number
      feeTiers?: Array<{
        minUsd?: number
        maxUsd?: number | null
        minPoints?: string
        maxPoints?: string | null
        platformFeeRateBp: number
        agentRewardRateBp: number
      }>
      serviceFeeUsd?: number
      minWithdrawalUsd?: number
      maxWithdrawalUsd?: number
      slaHours?: number
      waitingHours?: number
      maxAssignmentAttempts?: number
      inrPerUsd?: number
      nprPerUsd?: number
      countryRates?: Array<{
        country: string
        countryCode?: string | null
        currencyCode: string
        ratePerUsd: number
      }>
    },
  ) {
    const current = await prisma.payrollConfig.findUnique({ where: { id: 1 } })
    if (!current) {
      throw new AppError(500, 'Payroll config missing', 'CONFIG_ERROR')
    }

    const normalizedTiers = updates.feeTiers?.length
      ? normalizeAndValidateFeeTiers(updates.feeTiers)
      : null
    const normalizedCountryRates = updates.countryRates
      ? normalizeAndValidateCountryRates(updates.countryRates)
      : null

    const newAr =
      normalizedTiers?.[0]?.agentRewardRateBp ??
      updates.agentRewardRateBp ??
      current.agentRewardRateBp
    if (newAr > 10000) {
      throw new AppError(
        422,
        'Agent reward share cannot exceed 100% of platform fee',
        'INVALID_FEE_CONFIG',
      )
    }

    const data: Prisma.PayrollConfigUpdateInput = {}
    if (normalizedTiers) {
      data.platformFeeRateBp = normalizedTiers[0]!.platformFeeRateBp
      data.agentRewardRateBp = normalizedTiers[0]!.agentRewardRateBp
    } else {
      if (updates.platformFeeRateBp != null) data.platformFeeRateBp = updates.platformFeeRateBp
      if (updates.agentRewardRateBp != null) data.agentRewardRateBp = updates.agentRewardRateBp
    }
    if (updates.serviceFeeUsd != null)
      data.serviceFeeUsd = new Prisma.Decimal(updates.serviceFeeUsd)
    if (updates.minWithdrawalUsd != null)
      data.minWithdrawalUsd = new Prisma.Decimal(updates.minWithdrawalUsd)
    if (updates.maxWithdrawalUsd != null)
      data.maxWithdrawalUsd = new Prisma.Decimal(updates.maxWithdrawalUsd)
    if (updates.slaHours != null) data.slaHours = updates.slaHours
    if (updates.waitingHours != null) data.waitingHours = updates.waitingHours
    if (updates.maxAssignmentAttempts != null)
      data.maxAssignmentAttempts = updates.maxAssignmentAttempts
    if (normalizedCountryRates) {
      const inr = pickLegacyRate(normalizedCountryRates, {
        countries: ['india'],
        codes: ['IN', 'IND'],
        currency: 'INR',
      })
      const npr = pickLegacyRate(normalizedCountryRates, {
        countries: ['nepal'],
        codes: ['NP', 'NPL'],
        currency: 'NPR',
      })
      if (inr) data.inrPerUsd = inr
      else if (updates.inrPerUsd != null) data.inrPerUsd = new Prisma.Decimal(updates.inrPerUsd)
      if (npr) data.nprPerUsd = npr
      else if (updates.nprPerUsd != null) data.nprPerUsd = new Prisma.Decimal(updates.nprPerUsd)
    } else {
      if (updates.inrPerUsd != null) data.inrPerUsd = new Prisma.Decimal(updates.inrPerUsd)
      if (updates.nprPerUsd != null) data.nprPerUsd = new Prisma.Decimal(updates.nprPerUsd)
    }
    data.updatedByUserId = adminUserId

    await prisma.payrollConfig.update({
      where: { id: 1 },
      data,
    })

    if (normalizedTiers) {
      await payrollFeeTierRepository.softReplace(normalizedTiers)
    } else if (updates.agentRewardRateBp != null) {
      await payrollFeeTierRepository.updateAgentRewardOnActive(updates.agentRewardRateBp)
    }

    if (normalizedCountryRates) {
      await payrollCountryFxRepository.upsertActive(normalizedCountryRates)
    } else if (updates.inrPerUsd != null || updates.nprPerUsd != null) {
      const active = await payrollCountryFxRepository.findActive()
      if (active.length) {
        await payrollCountryFxRepository.upsertActive(
          active.map((row) => {
            const isInr =
              row.currencyCode.toUpperCase() === 'INR' ||
              row.country.toLowerCase() === 'india' ||
              row.countryCode?.toUpperCase() === 'IN'
            const isNpr =
              row.currencyCode.toUpperCase() === 'NPR' ||
              row.country.toLowerCase() === 'nepal' ||
              row.countryCode?.toUpperCase() === 'NP'
            let rate = row.ratePerUsd
            if (isInr && updates.inrPerUsd != null) rate = new Prisma.Decimal(updates.inrPerUsd)
            if (isNpr && updates.nprPerUsd != null) rate = new Prisma.Decimal(updates.nprPerUsd)
            return {
              country: row.country,
              countryCode: row.countryCode,
              currencyCode: row.currencyCode,
              ratePerUsd: rate,
            }
          }),
        )
      }
    }

    await withdrawalService.bustPayrollConfigCache()
    return withdrawalService.getPayrollConfig()
  },

  async listPendingPlatformWithdrawals(opts: {
    limit: number
    cursor?: string
    payoutHandler?: 'PLATFORM' | 'AGENCY'
  }) {
    const rows = await withdrawalRepository.listPendingPlatform(opts)
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined
    return {
      items: page.map((w) => withdrawalService.serializeWithdrawal(w)),
      nextCursor,
      hasMore,
    }
  },

  async manuallyAssignWithdrawal(
    adminUserId: string,
    withdrawalId: string,
    opts?: { agencyUserId?: string; agencyPublicId?: string },
  ) {
    const agencyUserId = await resolveAgencyUserId({
      agencyUserId: opts?.agencyUserId,
      agencyPublicId: opts?.agencyPublicId,
    })
    await withdrawalService.assignToAgency(withdrawalId, {
      overrideAgencyUserId: agencyUserId,
      allowBeyondAssignmentCap: true,
      rejectOnIneligibleOverride: !!agencyUserId,
      ignoreCountryMatch: !!agencyUserId,
    })
    auditService.log({
      userId: adminUserId,
      actionType: 'WITHDRAWAL_MANUAL_ASSIGN',
      actionStatus: 'success',
      actionDetails: {
        withdrawalId,
        agencyUserId: agencyUserId ?? null,
        agencyPublicId: opts?.agencyPublicId ?? null,
        ignoreCountryMatch: !!agencyUserId,
      },
    })
  },

  getDisputedPayrolls(opts: { limit: number; cursor?: string }) {
    return withdrawalService.getAdminDisputedPayrolls(opts)
  },

  async listAssignments(query: {
    status?: string
    agencyUserId?: string
    agencyPublicId?: string
    hostUserId?: string
    hostPublicId?: string
    withdrawalId?: string
    from?: string
    to?: string
    cursor?: string
    limit: number
  }) {
    const from = query.from ? new Date(query.from) : undefined
    const to = query.to ? new Date(query.to) : undefined
    if (from && Number.isNaN(from.getTime())) {
      throw new AppError(400, 'Invalid from', 'INVALID_REQUEST')
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new AppError(400, 'Invalid to', 'INVALID_REQUEST')
    }

    const [agencyUserId, hostUserId] = await Promise.all([
      resolveAgencyUserId({
        agencyUserId: query.agencyUserId,
        agencyPublicId: query.agencyPublicId,
      }),
      resolveHostUserId({
        hostUserId: query.hostUserId,
        hostPublicId: query.hostPublicId,
      }),
    ])

    const rows = await payrollAssignmentRepository.listForAdmin({
      status: query.status,
      agencyUserId,
      hostUserId,
      withdrawalId: query.withdrawalId,
      from,
      to,
      cursor: query.cursor,
      limit: query.limit,
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const config = await withdrawalService.getPayrollConfig()
    return {
      items: page.map((r) => mapAdminAssignment(r, config)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    }
  },

  async getAssignmentDetail(assignmentId: string) {
    const row = await payrollAssignmentRepository.getByIdForAdmin(assignmentId)
    if (!row) throw new AppError(404, 'Assignment not found', 'NOT_FOUND')
    const config = await withdrawalService.getPayrollConfig()
    return mapAdminAssignment(row, config)
  },

  async getWithdrawalDetail(withdrawalId: string) {
    const row = await prismaRead.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        paymentMethod: true,
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            avatarUrl: true,
            country: true,
          },
        },
      },
    })
    if (!row) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
    const config = await withdrawalService.getPayrollConfig()
    const serialized = withdrawalService.serializeWithdrawal(row)
    const hostPayoutUsd = Number(row.hostPayoutUsd ?? 0)
    const local = formatLocalAmount(hostPayoutUsd, resolveLocalFx(row.user.country, config))
    const waitingExpiresAt = row.waitingExpiresAt
    const waitingSecondsRemaining = waitingExpiresAt
      ? Math.max(0, Math.round((waitingExpiresAt.getTime() - Date.now()) / 1000))
      : 0
    return {
      ...serialized,
      withdrawalId: row.id,
      hostPayoutPoints: withdrawalHostPayoutPoints({
        amountPoints: row.amountPoints,
        platformFeePoints: row.platformFeePoints,
        serviceFeePoints: row.serviceFeePoints,
      }).toString(),
      localCurrencyAmount: local.localCurrencyAmount,
      localCurrencyCode: local.localCurrencyCode,
      waitingSecondsRemaining,
      canPay:
        (row.payoutHandler === 'PLATFORM' || row.methodType === 'EPAY') &&
        row.status === 'PENDING_PLATFORM',
      host: mapUserCard(row.user),
      paymentMethod: row.paymentMethod ? mapPaymentMethodMaskedForAgent(row.paymentMethod) : null,
    }
  },
}
