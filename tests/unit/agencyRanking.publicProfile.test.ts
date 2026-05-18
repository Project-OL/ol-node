import { describe, it, expect, vi, beforeEach } from "vitest";

const getAgencyByPublicId = vi.fn();
const getDisplayLevelsForUsers = vi.fn();
const userFindUnique = vi.fn();
const kycFindUnique = vi.fn();

vi.mock("../../src/repositories/agency.repository", () => ({
  agencyRepository: {
    getAgencyByPublicId: (...args: unknown[]) => getAgencyByPublicId(...args),
  },
}));

vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: {
    getDisplayLevelsForUsers: (...args: unknown[]) =>
      getDisplayLevelsForUsers(...args),
  },
}));

vi.mock("../../src/config/database", () => ({
  prismaRead: {
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
    },
    agencyApplicationKyc: {
      findUnique: (...args: unknown[]) => kycFindUnique(...args),
    },
  },
}));

import {
  agencyRankingService,
  mapAgencyToPublicProfile,
} from "../../src/services/agencyRanking.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mapAgencyToPublicProfile", () => {
  it("maps owner VIP display id and levels", () => {
    const profile = mapAgencyToPublicProfile({
      agency: {
        userId: "owner-1",
        defaultPublicId: 34216592n,
        displayName: "Dr Strange",
        totalHostsCount: 2,
        lifetimeHostEarningsPoints: 5000n,
        currentLevel: "C",
        pausedAt: null,
      },
      owner: {
        publicId: 34216592n,
        defaultPublicId: 34216592n,
        currentVipPublicId: 34263426n,
        gender: "female",
        dateOfBirth: new Date("1998-06-15"),
        avatarUrl: "https://cdn.example/avatar.png",
      },
      wealthLevel: 18,
      livestreamLevel: 1,
      agencyContactNumber: "+919999999999",
    });

    expect(profile.agencyPublicId).toBe("34216592");
    expect(profile.displayPublicId).toBe("34263426");
    expect(profile.publicId).toBe("34216592");
    expect(profile.wealthLevel).toBe(18);
    expect(profile.agencyContactNumber).toBe("+919999999999");
    expect(profile.lifetimeHostEarningsPoints).toBe("5000");
    expect(profile.age).toBeTypeOf("number");
  });
});

describe("agencyRankingService.getAgencyPublicProfile", () => {
  it("returns null when agency not found", async () => {
    getAgencyByPublicId.mockResolvedValue(null);

    const result = await agencyRankingService.getAgencyPublicProfile("999");

    expect(result).toBeNull();
  });

  it("loads enrichment for a valid public id", async () => {
    getAgencyByPublicId.mockResolvedValue({
      userId: "owner-1",
      defaultPublicId: 34216592n,
      displayName: "Dr Strange",
      totalHostsCount: 0,
      lifetimeHostEarningsPoints: 0n,
      currentLevel: "D",
      pausedAt: null,
    });
    getDisplayLevelsForUsers.mockResolvedValue(
      new Map([["owner-1", { wealthLevel: 5, livestreamLevel: 2 }]]),
    );
    userFindUnique.mockResolvedValue({
      publicId: 34216592n,
      defaultPublicId: 34216592n,
      currentVipPublicId: null,
      gender: "male",
      dateOfBirth: null,
      avatarUrl: null,
    });
    kycFindUnique.mockResolvedValue({ contactPhone: "+91111" });

    const result = await agencyRankingService.getAgencyPublicProfile("34216592");

    expect(result?.agencyUserId).toBe("owner-1");
    expect(result?.wealthLevel).toBe(5);
    expect(result?.agencyContactNumber).toBe("+91111");
  });
});
