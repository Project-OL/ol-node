import { redisClient, RedisKeys, PAYOUT_RAIL_CONFIG_TTL } from "../config/redis";
import { withdrawalPayoutRailConfigRepository } from "../repositories/withdrawalPayoutRailConfig.repository";

export type PayoutRailPublicDto = {
  epay: {
    feeRateBp: number;
    feePercent: number;
    arrivalTime: string;
  };
  bank: {
    feeRateBp: number;
    feePercent: number;
    arrivalTime: string;
  };
  updatedAt: string;
};

function toRailDto(feeRateBp: number, arrivalTime: string) {
  return {
    feeRateBp,
    feePercent: feeRateBp / 100,
    arrivalTime,
  };
}

function serialize(row: {
  epayFeeRateBp: number;
  epayArrivalTime: string;
  bankFeeRateBp: number;
  bankArrivalTime: string;
  updatedAt: Date;
}): PayoutRailPublicDto {
  return {
    epay: toRailDto(row.epayFeeRateBp, row.epayArrivalTime),
    bank: toRailDto(row.bankFeeRateBp, row.bankArrivalTime),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const withdrawalPayoutRailConfigService = {
  async getPublicConfig(): Promise<PayoutRailPublicDto> {
    const key = RedisKeys.payoutRailConfig();
    try {
      const hit = await redisClient.get(key);
      if (hit) return JSON.parse(hit) as PayoutRailPublicDto;
    } catch {
      /* miss */
    }

    const row = await withdrawalPayoutRailConfigRepository.getOrCreate();
    const dto = serialize(row);
    try {
      await redisClient.setex(key, PAYOUT_RAIL_CONFIG_TTL, JSON.stringify(dto));
    } catch {
      /* ignore */
    }
    return dto;
  },

  async bustCache() {
    await redisClient.del(RedisKeys.payoutRailConfig());
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      epay?: { feeRateBp?: number; arrivalTime?: string };
      bank?: { feeRateBp?: number; arrivalTime?: string };
    },
  ): Promise<PayoutRailPublicDto> {
    const current = await withdrawalPayoutRailConfigRepository.getOrCreate();
    const data: {
      epayFeeRateBp?: number;
      epayArrivalTime?: string;
      bankFeeRateBp?: number;
      bankArrivalTime?: string;
      updatedByUserId: string;
    } = { updatedByUserId: adminUserId };

    if (updates.epay?.feeRateBp != null) {
      data.epayFeeRateBp = updates.epay.feeRateBp;
    }
    if (updates.epay?.arrivalTime != null) {
      data.epayArrivalTime = updates.epay.arrivalTime;
    }
    if (updates.bank?.feeRateBp != null) {
      data.bankFeeRateBp = updates.bank.feeRateBp;
    }
    if (updates.bank?.arrivalTime != null) {
      data.bankArrivalTime = updates.bank.arrivalTime;
    }

    const row = await withdrawalPayoutRailConfigRepository.update({
      epayFeeRateBp: data.epayFeeRateBp ?? current.epayFeeRateBp,
      epayArrivalTime: data.epayArrivalTime ?? current.epayArrivalTime,
      bankFeeRateBp: data.bankFeeRateBp ?? current.bankFeeRateBp,
      bankArrivalTime: data.bankArrivalTime ?? current.bankArrivalTime,
      updatedByUserId: adminUserId,
    });

    await withdrawalPayoutRailConfigService.bustCache();
    return serialize(row);
  },
};
