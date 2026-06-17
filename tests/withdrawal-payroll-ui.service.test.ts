import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateAmounts,
  calculateWithdrawalAmounts,
  type PayrollConfigSnapshot,
  withdrawalService,
} from "../src/services/withdrawal.service";
import { agencyService } from "../src/services/agency.service";
import { AppError } from "../src/middlewares/errorHandler";
import {
  maskAccountNumber,
  maskEmail,
} from "../src/utils/payment-method-mask";
import {
  maskAccountNumber as maskAccountNumberFull,
  formatDuration,
} from "../src/utils/withdrawal-formatters";

const defaultConfig: PayrollConfigSnapshot = {
  id: 1,
  platformFeeRateBp: 500,
  agentRewardRateBp: 6000,
  serviceFeeUsd: 1,
  minWithdrawalUsd: 10,
  maxWithdrawalUsd: 10_000_000,
  slaHours: 2,
  maxAssignmentAttempts: 5,
  inrPerUsd: 88,
};

vi.mock("../src/config/database", () => ({
  prismaRead: {
    withdrawal: { findFirst: vi.fn() },
    payrollConfig: { findUnique: vi.fn() },
    agency: { findUnique: vi.fn() },
    pointLedgerEntry: { aggregate: vi.fn() },
  },
  prisma: { withdrawal: { update: vi.fn() } },
}));

vi.mock("../src/config/redis", () => ({
  redisClient: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn(),
    del: vi.fn(),
  },
  RedisKeys: {
    payrollConfig: () => "payroll:config",
    payrollSummary: (id: string) => `payroll:summary:${id}`,
  },
  PAYROLL_CONFIG_TTL: 3600,
  PAYROLL_SUMMARY_TTL: 30,
}));

vi.mock("../src/repositories/withdrawal.repository", () => ({
  withdrawalRepository: {
    findWithdrawalDetailForHost: vi.fn(),
  },
}));

vi.mock("../src/repositories/payrollAssignment.repository", () => ({
  payrollAssignmentRepository: {
    countInboxByStatus: vi.fn(),
  },
}));

vi.mock("../src/services/storage.service", () => ({
  storageService: {
    getPresignedPutUrl: vi.fn().mockResolvedValue("https://upload.example"),
    getPublicUrl: vi.fn((key: string) => `https://cdn.example/${key}`),
  },
}));

import { prismaRead } from "../src/config/database";
import { withdrawalRepository } from "../src/repositories/withdrawal.repository";
import { payrollAssignmentRepository } from "../src/repositories/payrollAssignment.repository";
import { storageService } from "../src/services/storage.service";

describe("calculateWithdrawalAmounts / calculateAmounts", () => {
  it("matches spec at min withdrawal 100k pts", () => {
    const gross = 100_000n;
    const r = calculateWithdrawalAmounts(gross, defaultConfig);
    expect(r.platformFeePoints).toBe(5000n);
    expect(r.agentRewardPoints).toBe(3000n);
    expect(r.hostPayoutPoints).toBe(95000n);
    expect(r.hostPayoutUsd.toString()).toBe("9.5");
    expect(r.serviceFeeUsd).toBe(1);
    expect(r.hostNetUsd).toBeCloseTo(8.5, 5);
  });

  it("aliases calculateAmounts export", () => {
    expect(calculateAmounts(100_000n, defaultConfig).hostPayoutPoints).toBe(
      95000n,
    );
  });

  it("rejects below min", () => {
    expect(() =>
      calculateWithdrawalAmounts(99_999n, defaultConfig),
    ).toThrowError(AppError);
  });

  it("rejects above max usd", () => {
    const gross = BigInt(10_000_000) * 10000n + 1n;
    expect(() => calculateWithdrawalAmounts(gross, defaultConfig)).toThrowError(
      AppError,
    );
  });

  it("accepts exactly max usd gross", () => {
    const gross = BigInt(10_000_000) * 10000n;
    const r = calculateWithdrawalAmounts(gross, defaultConfig);
    expect(r.hostPayoutPoints).toBeGreaterThan(0n);
  });

  it("truncates bp math for odd gross", () => {
    const cfg = { ...defaultConfig, agentRewardRateBp: 6000 };
    const r = calculateWithdrawalAmounts(1_000_001n, cfg);
    const platformFee = (1_000_001n * 500n) / 10000n;
    expect(platformFee).toBe(50000n);
    expect(r.agentRewardPoints).toBe((platformFee * 6000n) / 10000n);
  });
});

describe("payment method mask helpers", () => {
  it("masks account last 4", () => {
    expect(maskAccountNumber("12345678")).toBe("****5678");
  });

  it("masks email local prefix", () => {
    expect(maskEmail("user@gmail.com")).toBe("us***@gmail.com");
  });
});

describe("withdrawalService.getWithdrawalDetail", () => {
  beforeEach(() => {
    vi.mocked(withdrawalRepository.findWithdrawalDetailForHost).mockReset();
    vi.mocked(prismaRead.payrollConfig.findUnique).mockResolvedValue({
      id: 1,
      platformFeeRateBp: 600,
      agentRewardRateBp: 300,
      serviceFeeUsd: { toString: () => "1" },
      minWithdrawalUsd: { toString: () => "10" },
      maxWithdrawalUsd: { toString: () => "10000000" },
      slaHours: 2,
      maxAssignmentAttempts: 5,
      inrPerUsd: { toString: () => "88" },
      updatedAt: new Date(),
      updatedByUserId: null,
    } as never);
  });

  it("returns timeTakenSeconds when status is PAID", async () => {
    const requestedAt = new Date("2025-07-23T20:23:33.000Z");
    const processedAt = new Date("2025-07-23T20:24:34.000Z");
    vi.mocked(withdrawalRepository.findWithdrawalDetailForHost).mockResolvedValue({
      id: "w1",
      status: "PAID",
      amountPoints: 100000n,
      platformFeePoints: 6000n,
      agentRewardPoints: 3000n,
      hostPayoutUsd: { toString: () => "9.4" },
      notes: null,
      requestedAt,
      processedAt,
      disputeTicketId: null,
      assignmentCount: 1,
      payoutRef: "proof.jpg",
      paymentMethod: null,
      payrollAssignments: [],
    } as never);

    const detail = await withdrawalService.getWithdrawalDetail("w1", "u1");
    expect(detail.timeTakenSeconds).toBe(61);
    expect(detail.timeTakenFormatted).toBe("1m 1s");
  });

  it("returns null timeTakenSeconds when status is PENDING", async () => {
    vi.mocked(withdrawalRepository.findWithdrawalDetailForHost).mockResolvedValue({
      id: "w1",
      status: "PENDING",
      amountPoints: 100000n,
      platformFeePoints: 6000n,
      agentRewardPoints: 3000n,
      hostPayoutUsd: { toString: () => "9.4" },
      notes: null,
      requestedAt: new Date(),
      processedAt: null,
      disputeTicketId: null,
      assignmentCount: 0,
      payoutRef: null,
      paymentMethod: null,
      payrollAssignments: [],
    } as never);

    const detail = await withdrawalService.getWithdrawalDetail("w1", "u1");
    expect(detail.timeTakenSeconds).toBeNull();
    expect(detail.timeTakenFormatted).toBeNull();
  });

  it("computes localCurrencyAmount using inrPerUsd from config", async () => {
    vi.mocked(withdrawalRepository.findWithdrawalDetailForHost).mockResolvedValue({
      id: "w1",
      status: "PAID",
      amountPoints: 100000n,
      platformFeePoints: 6000n,
      agentRewardPoints: 3000n,
      hostPayoutUsd: { toString: () => "9.40" },
      notes: "urgent",
      requestedAt: new Date(),
      processedAt: new Date(),
      disputeTicketId: null,
      assignmentCount: 1,
      payoutRef: null,
      paymentMethod: null,
      payrollAssignments: [],
    } as never);

    const detail = await withdrawalService.getWithdrawalDetail("w1", "u1");
    expect(detail.localCurrencyAmount).toBe("827.20");
    expect(detail.localCurrencyCode).toBe("INR");
    expect(detail.notes).toBe("urgent");
  });

  it("throws NOT_FOUND when withdrawal does not belong to user", async () => {
    vi.mocked(withdrawalRepository.findWithdrawalDetailForHost).mockResolvedValue(null);
    await expect(
      withdrawalService.getWithdrawalDetail("missing", "u1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("withdrawalService.createDisputeEvidenceUploadUrl", () => {
  beforeEach(() => {
    vi.mocked(prismaRead.withdrawal.findFirst).mockReset();
  });

  it("returns presigned URL for PAID withdrawal", async () => {
    vi.mocked(prismaRead.withdrawal.findFirst).mockResolvedValue({
      status: "PAID",
    } as never);

    const result = await withdrawalService.createDisputeEvidenceUploadUrl(
      "w1",
      "u1",
      "image/jpeg",
    );
    expect(result.uploadUrl).toBe("https://upload.example");
    expect(result.s3Key).toMatch(/^withdrawal\/disputes\/u1\/w1\//);
    expect(result.expiresInSec).toBe(600);
    expect(storageService.getPresignedPutUrl).toHaveBeenCalled();
  });

  it("throws INVALID_STATE for PENDING withdrawal", async () => {
    vi.mocked(prismaRead.withdrawal.findFirst).mockResolvedValue({
      status: "PENDING",
    } as never);

    await expect(
      withdrawalService.createDisputeEvidenceUploadUrl("w1", "u1", "image/png"),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("agencyService.getPayrollSummary", () => {
  beforeEach(() => {
    vi.mocked(prismaRead.agency.findUnique).mockReset();
    vi.mocked(prismaRead.pointLedgerEntry.aggregate).mockReset();
    vi.mocked(payrollAssignmentRepository.countInboxByStatus).mockReset();
  });

  it("returns correct tabCounts from repository", async () => {
    vi.mocked(prismaRead.agency.findUnique).mockResolvedValue({
      payrollEnabled: true,
      pausedAt: null,
    } as never);
    vi.mocked(prismaRead.pointLedgerEntry.aggregate).mockResolvedValue({
      _sum: { amount: 89724n },
    } as never);
    vi.mocked(payrollAssignmentRepository.countInboxByStatus).mockResolvedValue({
      pending: 1,
      completed: 11,
    });

    const summary = await agencyService.getPayrollSummary("agent1");
    expect(summary.tabCounts).toEqual({ pending: 1, completed: 11 });
    expect(summary.totalRewardPoints).toBe("89724");
    expect(summary.takeOrderEnabled).toBe(true);
  });

  it("sets takeOrderEnabled=false when agency is paused", async () => {
    vi.mocked(prismaRead.agency.findUnique).mockResolvedValue({
      payrollEnabled: true,
      pausedAt: new Date(),
    } as never);
    vi.mocked(prismaRead.pointLedgerEntry.aggregate).mockResolvedValue({
      _sum: { amount: 0n },
    } as never);
    vi.mocked(payrollAssignmentRepository.countInboxByStatus).mockResolvedValue({
      pending: 0,
      completed: 0,
    });

    const summary = await agencyService.getPayrollSummary("agent1");
    expect(summary.takeOrderEnabled).toBe(false);
    expect(summary.isPaused).toBe(true);
  });
});

describe("maskAccountNumber (withdrawal-formatters)", () => {
  it("masks all but last 4 digits", () => {
    expect(maskAccountNumberFull("8006223499")).toBe("******3499");
  });
  it("returns raw when 4 chars or fewer", () => {
    expect(maskAccountNumberFull("1234")).toBe("1234");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute correctly", () => {
    expect(formatDuration(45)).toBe("45s");
  });
  it("formats minutes correctly", () => {
    expect(formatDuration(65)).toBe("1m 5s");
  });
  it("formats hours correctly", () => {
    expect(formatDuration(3601)).toBe("1h 0m");
  });
});
