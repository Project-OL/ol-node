import type { Prisma } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import type { BindBankInput } from "../models/paymentMethod.schemas";

export type MethodType = "EPAY" | "BANK";

export const userPaymentMethodRepository = {
  async upsert(
    data: {
      userId: string;
      methodType: MethodType;
      epayEmail?: string | null;
      bankName?: string | null;
      bankAccountHolder?: string | null;
      accountHolderFirstName?: string | null;
      accountHolderLastName?: string | null;
      branch?: string | null;
      bankAccountNumber?: string | null;
      bankIfscCode?: string | null;
      upiNumber?: string | null;
      registeredPhone?: string | null;
      registeredEmail?: string | null;
      lastUsedAt?: Date;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma;
    const now = data.lastUsedAt ?? new Date();
    return db.userPaymentMethod.upsert({
      where: {
        userId_methodType: { userId: data.userId, methodType: data.methodType },
      },
      create: {
        userId: data.userId,
        methodType: data.methodType,
        epayEmail: data.epayEmail ?? undefined,
        bankName: data.bankName ?? undefined,
        bankAccountHolder: data.bankAccountHolder ?? undefined,
        accountHolderFirstName: data.accountHolderFirstName ?? undefined,
        accountHolderLastName: data.accountHolderLastName ?? undefined,
        branch: data.branch ?? undefined,
        bankAccountNumber: data.bankAccountNumber ?? undefined,
        bankIfscCode: data.bankIfscCode ?? undefined,
        upiNumber: data.upiNumber ?? undefined,
        registeredPhone: data.registeredPhone ?? undefined,
        registeredEmail: data.registeredEmail ?? undefined,
        lastUsedAt: now,
      },
      update: {
        epayEmail: data.epayEmail ?? undefined,
        bankName: data.bankName ?? undefined,
        bankAccountHolder: data.bankAccountHolder ?? undefined,
        accountHolderFirstName: data.accountHolderFirstName ?? undefined,
        accountHolderLastName: data.accountHolderLastName ?? undefined,
        branch: data.branch ?? undefined,
        bankAccountNumber: data.bankAccountNumber ?? undefined,
        bankIfscCode: data.bankIfscCode ?? undefined,
        upiNumber: data.upiNumber ?? undefined,
        registeredPhone: data.registeredPhone ?? undefined,
        registeredEmail: data.registeredEmail ?? undefined,
        lastUsedAt: now,
      },
    });
  },

  async upsertBank(userId: string, data: BindBankInput) {
    const holderName = `${data.firstName} ${data.lastName}`.trim();
    return this.upsert({
      userId,
      methodType: "BANK",
      accountHolderFirstName: data.firstName,
      accountHolderLastName: data.lastName,
      bankAccountHolder: holderName,
      bankName: data.bankName,
      branch: data.branch ?? null,
      bankIfscCode: data.ifscCode,
      bankAccountNumber: data.accountNumber,
      upiNumber: data.upiId ?? null,
      registeredEmail: data.email ?? null,
      registeredPhone: data.phone ?? null,
    });
  },

  async findAllForUser(userId: string) {
    return prismaRead.userPaymentMethod.findMany({
      where: { userId },
    });
  },

  async findById(id: string, userId: string) {
    return prismaRead.userPaymentMethod.findFirst({
      where: { id, userId },
    });
  },

  async touchLastUsed(
    id: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma;
    return db.userPaymentMethod.updateMany({
      where: { id, userId },
      data: { lastUsedAt: new Date() },
    });
  },

  async deleteByUserAndType(
    userId: string,
    methodType: MethodType,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma;
    return db.userPaymentMethod.deleteMany({
      where: { userId, methodType },
    });
  },
};
