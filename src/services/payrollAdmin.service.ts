import { Prisma } from "@prisma/client";
import { prisma } from "../config/database";
import { AppError } from "../middlewares/errorHandler";
import { withdrawalService } from "./withdrawal.service";
import { auditService } from "./audit.service";
import { withdrawalRepository } from "../repositories/withdrawal.repository";

export const payrollAdminService = {
  getConfig() {
    return withdrawalService.getPayrollConfig();
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      platformFeeRateBp?: number;
      agentRewardRateBp?: number;
      serviceFeeUsd?: number;
      minWithdrawalUsd?: number;
      maxWithdrawalUsd?: number;
      slaHours?: number;
      maxAssignmentAttempts?: number;
      inrPerUsd?: number;
    },
  ) {
    const current = await prisma.payrollConfig.findUnique({ where: { id: 1 } });
    if (!current) {
      throw new AppError(500, "Payroll config missing", "CONFIG_ERROR");
    }

    const newPf = updates.platformFeeRateBp ?? current.platformFeeRateBp;
    const newAr = updates.agentRewardRateBp ?? current.agentRewardRateBp;
    if (newAr > newPf) {
      throw new AppError(
        422,
        "Agent reward rate cannot exceed platform fee rate",
        "INVALID_FEE_CONFIG",
      );
    }

    const data: Prisma.PayrollConfigUpdateInput = {};
    if (updates.platformFeeRateBp != null)
      data.platformFeeRateBp = updates.platformFeeRateBp;
    if (updates.agentRewardRateBp != null)
      data.agentRewardRateBp = updates.agentRewardRateBp;
    if (updates.serviceFeeUsd != null)
      data.serviceFeeUsd = new Prisma.Decimal(updates.serviceFeeUsd);
    if (updates.minWithdrawalUsd != null)
      data.minWithdrawalUsd = new Prisma.Decimal(updates.minWithdrawalUsd);
    if (updates.maxWithdrawalUsd != null)
      data.maxWithdrawalUsd = new Prisma.Decimal(updates.maxWithdrawalUsd);
    if (updates.slaHours != null) data.slaHours = updates.slaHours;
    if (updates.maxAssignmentAttempts != null)
      data.maxAssignmentAttempts = updates.maxAssignmentAttempts;
    if (updates.inrPerUsd != null)
      data.inrPerUsd = new Prisma.Decimal(updates.inrPerUsd);
    data.updatedByUserId = adminUserId;

    await prisma.payrollConfig.update({
      where: { id: 1 },
      data,
    });

    await withdrawalService.bustPayrollConfigCache();
  },

  async listPendingPlatformWithdrawals(opts: {
    limit: number;
    cursor?: string;
  }) {
    const rows = await withdrawalRepository.listPendingPlatform(opts);
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
    return {
      items: page.map((w) => withdrawalService.serializeWithdrawal(w)),
      nextCursor,
      hasMore,
    };
  },

  async manuallyAssignWithdrawal(
    adminUserId: string,
    withdrawalId: string,
    agencyUserId?: string,
  ) {
    await withdrawalService.assignToAgency(withdrawalId, {
      overrideAgencyUserId: agencyUserId,
      allowBeyondAssignmentCap: true,
    });
    auditService.log({
      userId: adminUserId,
      actionType: "WITHDRAWAL_MANUAL_ASSIGN",
      actionStatus: "success",
      actionDetails: { withdrawalId, agencyUserId: agencyUserId ?? null },
    });
  },
};
