import { redisClient, RedisKeys, WALLET_BALANCE_TTL } from "../config/redis";
import { AppError } from "../middlewares/errorHandler";
import {
  userPaymentMethodRepository,
  type MethodType,
} from "../repositories/userPaymentMethod.repository";
import { withdrawalRepository } from "../repositories/withdrawal.repository";
import { securityPasswordService } from "./security-password.service";
import {
  maskPaymentMethodForDisplay,
  maskAccountNumber,
  maskEmail,
} from "../utils/payment-method-mask";
import type { BindBankInput } from "../models/paymentMethod.schemas";

export { maskAccountNumber, maskEmail, maskPaymentMethodForDisplay };

export const userPaymentMethodService = {
  async bindEpay(
    userId: string,
    body: { epayEmail: string },
    securityPassword: string,
  ) {
    await securityPasswordService.verifyCurrentPassword(userId, securityPassword);
    await userPaymentMethodRepository.upsert({
      userId,
      methodType: "EPAY",
      epayEmail: body.epayEmail,
    });
    await redisClient.del(RedisKeys.userPaymentMethods(userId));
  },

  async bindBank(userId: string, body: BindBankInput, securityPassword: string) {
    await securityPasswordService.verifyCurrentPassword(userId, securityPassword);
    await userPaymentMethodRepository.upsertBank(userId, body);
    await redisClient.del(RedisKeys.userPaymentMethods(userId));
  },

  async unbind(userId: string, methodType: MethodType) {
    const row = await userPaymentMethodRepository.findAllForUser(userId);
    const target = row.find((r) => r.methodType === methodType);
    if (!target) return;

    const blocks = await withdrawalRepository.hasPendingWithdrawalUsingMethod(
      userId,
      target.id,
    );
    if (blocks) {
      throw new AppError(
        409,
        "Payment method is referenced by an in-progress withdrawal",
        "PAYMENT_METHOD_IN_USE",
      );
    }

    await userPaymentMethodRepository.deleteByUserAndType(userId, methodType);
    await redisClient.del(RedisKeys.userPaymentMethods(userId));
  },

  async getMyMethods(userId: string) {
    const cacheKey = RedisKeys.userPaymentMethods(userId);
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as ReturnType<
        typeof userPaymentMethodService.serializeMaskedList
      >;
    }

    const rows = await userPaymentMethodRepository.findAllForUser(userId);
    const masked = userPaymentMethodService.serializeMaskedList(rows);
    await redisClient.setex(
      cacheKey,
      WALLET_BALANCE_TTL,
      JSON.stringify(masked),
    );
    return masked;
  },

  serializeMaskedList(
    rows: Awaited<ReturnType<typeof userPaymentMethodRepository.findAllForUser>>,
  ) {
    return rows.map((r) => {
      const masked = maskPaymentMethodForDisplay(r);
      if (r.methodType === "BANK") {
        return {
          id: r.id,
          methodType: "BANK" as const,
          bankName: masked.bankName,
          accountNumber: masked.bankAccountNumber,
          firstName: masked.firstName ?? null,
          lastName: masked.lastName ?? null,
          branch: masked.branch ?? null,
        };
      }
      return {
        id: r.id,
        methodType: "EPAY" as const,
        epayEmail: masked.epayEmail,
      };
    });
  },
};
