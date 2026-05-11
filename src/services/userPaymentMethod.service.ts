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

  async bindBank(
    userId: string,
    body: {
      accountHolderName: string;
      bankName: string;
      ifscCode: string;
      accountNumber: string;
      upiNumber?: string;
      registeredPhone?: string;
      registeredEmail?: string;
    },
  ) {
    if (
      !body.accountHolderName?.trim() ||
      !body.bankName?.trim() ||
      !body.ifscCode?.trim() ||
      !body.accountNumber?.trim()
    ) {
      throw new AppError(
        422,
        "Missing required bank fields",
        "INVALID_BANK_FIELDS",
      );
    }
    await userPaymentMethodRepository.upsert({
      userId,
      methodType: "BANK",
      bankAccountHolder: body.accountHolderName,
      bankName: body.bankName,
      bankIfscCode: body.ifscCode,
      bankAccountNumber: body.accountNumber,
      upiNumber: body.upiNumber,
      registeredPhone: body.registeredPhone,
      registeredEmail: body.registeredEmail,
    });
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
    return rows.map((r) => maskPaymentMethodForDisplay(r));
  },
};
