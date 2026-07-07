import { redisClient, RedisKeys, WALLET_BALANCE_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  userPaymentMethodRepository,
  type MethodType,
} from '../repositories/userPaymentMethod.repository'
import { withdrawalRepository } from '../repositories/withdrawal.repository'
import { securityPasswordService } from './security-password.service'
import {
  maskPaymentMethodForDisplay,
  maskAccountNumber,
  maskEmail,
  mapPaymentMethodFull,
} from '../utils/payment-method-mask'
import type { BindBankInput } from '../models/paymentMethod.schemas'
import type { PayoutRailPublicDto } from './withdrawalPayoutRailConfig.service'
import { withdrawalPayoutRailConfigService } from './withdrawalPayoutRailConfig.service'
import { isUniqueViolation } from '../utils/txRetry'

export { maskAccountNumber, maskEmail, maskPaymentMethodForDisplay }

function railFieldsForType(
  methodType: MethodType,
  rails: PayoutRailPublicDto,
): { feeRateBp: number; feePercent: number; arrivalTime: string } {
  const rail = methodType === 'EPAY' ? rails.epay : rails.bank
  return {
    feeRateBp: rail.feeRateBp,
    feePercent: rail.feePercent,
    arrivalTime: rail.arrivalTime,
  }
}

export const userPaymentMethodService = {
  async bindEpay(userId: string, body: { epayEmail: string }, securityPassword: string) {
    await securityPasswordService.verifyCurrentPassword(userId, securityPassword)
    // Native ON CONFLICT upsert on (userId, methodType) is race-safe; the
    // retry-once covers Prisma's emulated-upsert fallback where a parallel
    // first bind can surface P2002 instead of converging to an update.
    try {
      await userPaymentMethodRepository.upsert({
        userId,
        methodType: 'EPAY',
        epayEmail: body.epayEmail,
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      await userPaymentMethodRepository.upsert({
        userId,
        methodType: 'EPAY',
        epayEmail: body.epayEmail,
      })
    }
    await redisClient.del(RedisKeys.userPaymentMethods(userId))
  },

  async bindBank(userId: string, body: BindBankInput, securityPassword: string) {
    await securityPasswordService.verifyCurrentPassword(userId, securityPassword)
    try {
      await userPaymentMethodRepository.upsertBank(userId, body)
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      await userPaymentMethodRepository.upsertBank(userId, body)
    }
    await redisClient.del(RedisKeys.userPaymentMethods(userId))
  },

  async unbind(userId: string, methodType: MethodType) {
    const row = await userPaymentMethodRepository.findAllForUser(userId)
    const target = row.find((r) => r.methodType === methodType)
    if (!target) return

    const blocks = await withdrawalRepository.hasPendingWithdrawalUsingMethod(userId, target.id)
    if (blocks) {
      throw new AppError(
        409,
        'Payment method is referenced by an in-progress withdrawal',
        'PAYMENT_METHOD_IN_USE',
      )
    }

    await userPaymentMethodRepository.deleteByUserAndType(userId, methodType)
    await redisClient.del(RedisKeys.userPaymentMethods(userId))
  },

  async getMyMethods(userId: string) {
    const cacheKey = RedisKeys.userPaymentMethods(userId)
    const rails = await withdrawalPayoutRailConfigService.getPublicConfig()
    const cached = await redisClient.get(cacheKey)
    let methods: ReturnType<typeof userPaymentMethodService.serializeOwnerList>
    if (cached) {
      methods = JSON.parse(cached) as ReturnType<typeof userPaymentMethodService.serializeOwnerList>
    } else {
      const rows = await userPaymentMethodRepository.findAllForUser(userId)
      methods = userPaymentMethodService.serializeOwnerList(rows)
      await redisClient.setex(cacheKey, WALLET_BALANCE_TTL, JSON.stringify(methods))
    }
    return {
      methods: methods.map((m) => ({
        ...m,
        ...railFieldsForType(m.methodType, rails),
      })),
    }
  },

  /** Full unmasked details for the owning user (`GET /payment-methods`). */
  serializeOwnerList(rows: Awaited<ReturnType<typeof userPaymentMethodRepository.findAllForUser>>) {
    return rows.map((r) => {
      const lastUsed = r.lastUsedAt?.toISOString() ?? null
      const full = mapPaymentMethodFull(r)
      if (full.methodType === 'BANK') {
        return {
          id: r.id,
          methodType: 'BANK' as const,
          firstName: full.firstName ?? null,
          lastName: full.lastName ?? null,
          bankName: full.bankName ?? null,
          branch: full.branch ?? null,
          ifscCode: full.ifscCode ?? null,
          accountNumber: full.accountNumber ?? null,
          upiId: full.upiId ?? null,
          email: full.email ?? null,
          phone: full.phone ?? null,
          lastUsed,
        }
      }
      return {
        id: r.id,
        methodType: 'EPAY' as const,
        epayEmail: full.epayEmail ?? null,
        lastUsed,
      }
    })
  },

  async touchLastUsed(userId: string, paymentMethodId: string) {
    await userPaymentMethodRepository.touchLastUsed(paymentMethodId, userId)
    await redisClient.del(RedisKeys.userPaymentMethods(userId))
  },
}
