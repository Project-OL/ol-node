import { prisma } from '../config/database'
import { redisClient, RedisKeys, PAYOUT_RAIL_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { withdrawalPayoutRailConfigRepository } from '../repositories/withdrawalPayoutRailConfig.repository'
import {
  applyBankFieldRuleUpdates,
  resolveBankFieldRules,
  toBankFieldRuleDtos,
  type BankFieldKey,
  type BankFieldRule,
  type BankFieldRuleDto,
  type BankFieldRules,
} from '../utils/bank-field-rules'

type RailDto = {
  feeRateBp: number
  feePercent: number
  arrivalTime: string
  enabled: boolean
}

export type PayoutRailPublicDto = {
  /**
   * EPAY is switched per audience. `enabled` is true when it is on for anyone
   * (agents OR users); the per-caller value is in GET /payment-methods.
   */
  epay: RailDto & {
    /** Users with `is_agent = true`. Stored in `epay_enabled`. */
    enabledForAgents: boolean
    /** Everyone else (hosts and plain users). Stored in `epay_users_enabled`. */
    enabledForUsers: boolean
  }
  bank: RailDto
  /** BANK bind-form field rules (required / format toggles), in form order. */
  bankFields: BankFieldRuleDto[]
  updatedAt: string
}

function toRailDto(feeRateBp: number, arrivalTime: string, enabled: boolean): RailDto {
  return {
    feeRateBp,
    feePercent: feeRateBp / 100,
    arrivalTime,
    enabled,
  }
}

function serialize(row: {
  epayFeeRateBp: number
  epayArrivalTime: string
  epayEnabled: boolean
  epayUsersEnabled: boolean
  bankFeeRateBp: number
  bankArrivalTime: string
  bankEnabled: boolean
  bankFieldRules: unknown
  updatedAt: Date
}): PayoutRailPublicDto {
  return {
    epay: {
      ...toRailDto(row.epayFeeRateBp, row.epayArrivalTime, row.epayEnabled || row.epayUsersEnabled),
      enabledForAgents: row.epayEnabled,
      enabledForUsers: row.epayUsersEnabled,
    },
    bank: toRailDto(row.bankFeeRateBp, row.bankArrivalTime, row.bankEnabled),
    bankFields: toBankFieldRuleDtos(resolveBankFieldRules(row.bankFieldRules)),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Whether a rail is open for a caller; EPAY depends on the caller being an agent. */
export function railEnabledFor(
  config: PayoutRailPublicDto,
  methodType: 'EPAY' | 'BANK',
  isAgent: boolean,
): boolean {
  if (methodType === 'BANK') return config.bank.enabled
  return isAgent ? config.epay.enabledForAgents : config.epay.enabledForUsers
}

export const withdrawalPayoutRailConfigService = {
  async getPublicConfig(): Promise<PayoutRailPublicDto> {
    const key = RedisKeys.payoutRailConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as PayoutRailPublicDto
        if (parsed.bank && typeof parsed.bank.enabled !== 'boolean') {
          parsed.bank.enabled = true
        }
        // Warm cache written before `bankFields` or the per-audience EPAY switch
        // existed: treat as a miss and reload, never guess the users' EPAY state.
        if (
          Array.isArray(parsed.bankFields) &&
          typeof parsed.epay?.enabledForAgents === 'boolean' &&
          typeof parsed.epay?.enabledForUsers === 'boolean'
        ) {
          return parsed
        }
      }
    } catch {
      /* miss */
    }

    const row = await withdrawalPayoutRailConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, PAYOUT_RAIL_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async bustCache() {
    await redisClient.del(RedisKeys.payoutRailConfig())
  },

  /**
   * Fresh `is_agent` read (primary, one PK lookup). Not cached: the flag flips when
   * an agency is created or removed. A missing user counts as a non-agent.
   */
  async isAgentUser(userId: string): Promise<boolean> {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { isAgent: true } })
    return u?.isAgent === true
  },

  /** Throws 403 PAYMENT_METHOD_DISABLED when the rail is admin-disabled for this user. */
  async assertRailEnabled(methodType: 'EPAY' | 'BANK', userId: string): Promise<void> {
    const config = await withdrawalPayoutRailConfigService.getPublicConfig()
    const isAgent =
      methodType === 'EPAY' ? await withdrawalPayoutRailConfigService.isAgentUser(userId) : false
    if (!railEnabledFor(config, methodType, isAgent)) {
      throw new AppError(
        403,
        `${methodType} payment method is currently disabled`,
        'PAYMENT_METHOD_DISABLED',
      )
    }
  },

  /** Active BANK field rules as a keyed map (for server-side validation). */
  async getBankFieldRules(): Promise<BankFieldRules> {
    const config = await withdrawalPayoutRailConfigService.getPublicConfig()
    const map: Partial<Record<BankFieldKey, BankFieldRule>> = {}
    for (const f of config.bankFields) map[f.field] = { required: f.required, validate: f.validate }
    return resolveBankFieldRules(map)
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      epay?: {
        feeRateBp?: number
        arrivalTime?: string
        /** Legacy single switch: maps to the agents' switch only, never to users. */
        enabled?: boolean
        enabledForAgents?: boolean
        enabledForUsers?: boolean
      }
      bank?: { feeRateBp?: number; arrivalTime?: string; enabled?: boolean }
      bankFields?: Partial<Record<BankFieldKey, Partial<BankFieldRule>>>
    },
  ): Promise<PayoutRailPublicDto> {
    const current = await withdrawalPayoutRailConfigRepository.getOrCreate()
    const epayAgents = updates.epay?.enabledForAgents ?? updates.epay?.enabled

    const row = await withdrawalPayoutRailConfigRepository.update({
      epayFeeRateBp: updates.epay?.feeRateBp ?? current.epayFeeRateBp,
      epayArrivalTime: updates.epay?.arrivalTime ?? current.epayArrivalTime,
      epayEnabled: epayAgents ?? current.epayEnabled,
      epayUsersEnabled: updates.epay?.enabledForUsers ?? current.epayUsersEnabled,
      bankFeeRateBp: updates.bank?.feeRateBp ?? current.bankFeeRateBp,
      bankArrivalTime: updates.bank?.arrivalTime ?? current.bankArrivalTime,
      bankEnabled: updates.bank?.enabled ?? current.bankEnabled,
      ...(updates.bankFields && {
        bankFieldRules: applyBankFieldRuleUpdates(
          resolveBankFieldRules(current.bankFieldRules),
          updates.bankFields,
        ),
      }),
      updatedByUserId: adminUserId,
    })

    await withdrawalPayoutRailConfigService.bustCache()
    return serialize(row)
  },
}
