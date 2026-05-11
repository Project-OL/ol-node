import type { Prisma } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";

export type MethodType = "EPAY" | "BANK";

export const userPaymentMethodRepository = {
  async upsert(
    data: {
      userId: string;
      methodType: MethodType;
      epayEmail?: string | null;
      bankName?: string | null;
      bankAccountHolder?: string | null;
      bankAccountNumber?: string | null;
      bankIfscCode?: string | null;
      upiNumber?: string | null;
      registeredPhone?: string | null;
      registeredEmail?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma;
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
        bankAccountNumber: data.bankAccountNumber ?? undefined,
        bankIfscCode: data.bankIfscCode ?? undefined,
        upiNumber: data.upiNumber ?? undefined,
        registeredPhone: data.registeredPhone ?? undefined,
        registeredEmail: data.registeredEmail ?? undefined,
      },
      update: {
        epayEmail: data.epayEmail ?? undefined,
        bankName: data.bankName ?? undefined,
        bankAccountHolder: data.bankAccountHolder ?? undefined,
        bankAccountNumber: data.bankAccountNumber ?? undefined,
        bankIfscCode: data.bankIfscCode ?? undefined,
        upiNumber: data.upiNumber ?? undefined,
        registeredPhone: data.registeredPhone ?? undefined,
        registeredEmail: data.registeredEmail ?? undefined,
      },
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
