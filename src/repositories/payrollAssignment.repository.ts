import type { Prisma } from "@prisma/client";
import { prismaRead } from "../config/database";
import { maskPaymentMethodForDisplay } from "../utils/payment-method-mask";

export type WithdrawalWithMethodRow = {
  assignment: {
    id: string;
    withdrawalId: string;
    agencyUserId: string;
    assignedAt: Date;
    expiresAt: Date;
    status: string;
    proofS3Key: string | null;
    proofS3Bucket: string | null;
    completedAt: Date | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
    assignmentNumber: number;
    createdAt: Date;
  };
  withdrawal: {
    id: string;
    userId: string;
    amountPoints: bigint;
    status: string;
    requestedAt: Date;
    processedAt: Date | null;
    hostPayoutUsd: Prisma.Decimal | null;
    assignmentCount: number;
  };
  paymentMethod: {
    id: string;
    methodType: string;
    epayEmail: string | null;
    bankName: string | null;
    bankAccountHolder: string | null;
    bankAccountNumber: string | null;
    bankIfscCode: string | null;
    upiNumber: string | null;
    registeredPhone: string | null;
    registeredEmail: string | null;
  } | null;
  revealPii: boolean;
};

export const payrollAssignmentRepository = {
  async create(
    data: {
      id: string;
      withdrawalId: string;
      agencyUserId: string;
      expiresAt: Date;
      assignmentNumber: number;
      status?: string;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.withdrawalPayrollAssignment.create({
      data: {
        id: data.id,
        withdrawalId: data.withdrawalId,
        agencyUserId: data.agencyUserId,
        expiresAt: data.expiresAt,
        assignmentNumber: data.assignmentNumber,
        status: data.status ?? "PENDING",
      },
    });
  },

  getById(id: string) {
    return prismaRead.withdrawalPayrollAssignment.findUnique({
      where: { id },
    });
  },

  getByIdForAgent(id: string, agencyUserId: string) {
    return prismaRead.withdrawalPayrollAssignment.findFirst({
      where: { id, agencyUserId },
    });
  },

  async getByIdWithWithdrawalAndMethod(
    id: string,
    agencyUserId: string,
    now: Date,
  ): Promise<WithdrawalWithMethodRow | null> {
    const row = await prismaRead.withdrawalPayrollAssignment.findFirst({
      where: { id, agencyUserId },
      include: {
        withdrawal: {
          include: {
            paymentMethod: true,
          },
        },
      },
    });
    if (!row) return null;

    const revealPii =
      row.status === "PENDING" &&
      row.expiresAt > now &&
      row.agencyUserId === agencyUserId;

    let paymentMethod = row.withdrawal.paymentMethod;
    if (paymentMethod && !revealPii) {
      paymentMethod = maskPaymentMethodForDisplay(
        paymentMethod,
      ) as typeof paymentMethod;
    }

    return {
      assignment: {
        id: row.id,
        withdrawalId: row.withdrawalId,
        agencyUserId: row.agencyUserId,
        assignedAt: row.assignedAt,
        expiresAt: row.expiresAt,
        status: row.status,
        proofS3Key: row.proofS3Key,
        proofS3Bucket: row.proofS3Bucket,
        completedAt: row.completedAt,
        rejectedAt: row.rejectedAt,
        rejectionReason: row.rejectionReason,
        assignmentNumber: row.assignmentNumber,
        createdAt: row.createdAt,
      },
      withdrawal: {
        id: row.withdrawal.id,
        userId: row.withdrawal.userId,
        amountPoints: row.withdrawal.amountPoints,
        status: row.withdrawal.status,
        requestedAt: row.withdrawal.requestedAt,
        processedAt: row.withdrawal.processedAt,
        hostPayoutUsd: row.withdrawal.hostPayoutUsd,
        assignmentCount: row.withdrawal.assignmentCount,
      },
      paymentMethod,
      revealPii,
    };
  },

  async listForAgent(
    agencyUserId: string,
    opts: {
      status?: string;
      limit: number;
      cursor?: string;
    },
  ) {
    const take = opts.limit + 1;
    return prismaRead.withdrawalPayrollAssignment.findMany({
      where: {
        agencyUserId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { assignedAt: "desc" },
      take,
      ...(opts.cursor
        ? {
            cursor: { id: opts.cursor },
            skip: 1,
          }
        : {}),
      include: {
        withdrawal: { select: { id: true, status: true, amountPoints: true } },
      },
    });
  },

  async updateStatus(
    data: {
      id: string;
      status: string;
      proofS3Key?: string | null;
      proofS3Bucket?: string | null;
      completedAt?: Date | null;
      rejectedAt?: Date | null;
      rejectionReason?: string | null;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.withdrawalPayrollAssignment.update({
      where: { id: data.id },
      data: {
        status: data.status,
        ...(data.proofS3Key !== undefined ? { proofS3Key: data.proofS3Key } : {}),
        ...(data.proofS3Bucket !== undefined
          ? { proofS3Bucket: data.proofS3Bucket }
          : {}),
        ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
        ...(data.rejectedAt !== undefined ? { rejectedAt: data.rejectedAt } : {}),
        ...(data.rejectionReason !== undefined
          ? { rejectionReason: data.rejectionReason }
          : {}),
      },
    });
  },

  findCompletedForWithdrawal(withdrawalId: string) {
    return prismaRead.withdrawalPayrollAssignment.findFirst({
      where: { withdrawalId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
    });
  },
};
