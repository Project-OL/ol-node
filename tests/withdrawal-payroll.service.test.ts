import { describe, expect, it } from "vitest";
import {
  calculateAmounts,
  calculateWithdrawalAmounts,
  type PayrollConfigSnapshot,
} from "../src/services/withdrawal.service";
import { AppError } from "../src/middlewares/errorHandler";
import {
  maskAccountNumber,
  maskEmail,
} from "../src/utils/payment-method-mask";

const defaultConfig: PayrollConfigSnapshot = {
  id: 1,
  platformFeeRateBp: 500,
  agentRewardRateBp: 6000,
  serviceFeeUsd: 1,
  minWithdrawalUsd: 10,
  maxWithdrawalUsd: 10_000_000,
  slaHours: 2,
  waitingHours: 2,
  maxAssignmentAttempts: 5,
  inrPerUsd: 88,
};

describe("calculateWithdrawalAmounts / calculateAmounts", () => {
  it("EPAY $10: $1 service fee, host $9, no tiers", () => {
    const r = calculateWithdrawalAmounts(100_000n, defaultConfig, "EPAY");
    expect(r.serviceFeePoints).toBe(10_000n);
    expect(r.platformFeePoints).toBe(0n);
    expect(r.agentRewardPoints).toBe(0n);
    expect(r.hostPayoutPoints).toBe(90_000n);
    expect(r.hostPayoutUsd.toString()).toBe("9");
    expect(r.serviceFeeUsd).toBe(1);
    expect(r.hostNetUsd).toBeCloseTo(9, 5);
  });

  it("BANK $10: no service fee, 5% of full gross", () => {
    const r = calculateWithdrawalAmounts(100_000n, defaultConfig, "BANK");
    expect(r.serviceFeePoints).toBe(0n);
    expect(r.platformFeePoints).toBe(5_000n);
    expect(r.agentRewardPoints).toBe(3_000n);
    expect(r.hostPayoutPoints).toBe(95_000n);
    expect(r.hostPayoutUsd.toString()).toBe("9.5");
    expect(r.hostNetUsd).toBeCloseTo(9.5, 5);
  });

  it("aliases calculateAmounts export (BANK default)", () => {
    expect(calculateAmounts(100_000n, defaultConfig).hostPayoutPoints).toBe(
      95_000n,
    );
  });

  it("rejects below min", () => {
    expect(() =>
      calculateWithdrawalAmounts(99_999n, defaultConfig, "BANK"),
    ).toThrowError(AppError);
  });

  it("rejects above max usd", () => {
    const gross = BigInt(10_000_000) * 10000n + 1n;
    expect(() =>
      calculateWithdrawalAmounts(gross, defaultConfig, "BANK"),
    ).toThrowError(AppError);
  });

  it("accepts exactly max usd gross", () => {
    const gross = BigInt(10_000_000) * 10000n;
    const r = calculateWithdrawalAmounts(gross, defaultConfig, "BANK");
    expect(r.hostPayoutPoints).toBeGreaterThan(0n);
  });

  it("BANK truncates bp math for odd gross at 10L+ tier (2%)", () => {
    const cfg = { ...defaultConfig, agentRewardRateBp: 6000 };
    const r = calculateWithdrawalAmounts(1_000_001n, cfg, "BANK");
    const platformFee = (1_000_001n * 200n) / 10000n;
    expect(platformFee).toBe(20_000n);
    expect(r.agentRewardPoints).toBe((platformFee * 6000n) / 10000n);
  });

  it("BANK uses configured feeTiers on full gross", () => {
    const cfg: PayrollConfigSnapshot = {
      ...defaultConfig,
      feeTiers: [
        {
          minPoints: "0",
          maxPoints: "200000",
          minUsd: 0,
          maxUsd: 20,
          platformFeeRateBp: 400,
          agentRewardRateBp: 5000,
          sortOrder: 1,
        },
        {
          minPoints: "200000",
          maxPoints: null,
          minUsd: 20,
          maxUsd: null,
          platformFeeRateBp: 250,
          agentRewardRateBp: 7000,
          sortOrder: 2,
        },
      ],
    };
    const low = calculateWithdrawalAmounts(100_000n, cfg, "BANK");
    expect(low.platformFeeRateBp).toBe(400);
    expect(low.platformFeePoints).toBe(4_000n);
    expect(low.agentRewardPoints).toBe(2_000n);

    const high = calculateWithdrawalAmounts(200_000n, cfg, "BANK");
    expect(high.platformFeeRateBp).toBe(250);
    expect(high.platformFeePoints).toBe(5_000n);
    expect(high.agentRewardPoints).toBe(3_500n);
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
