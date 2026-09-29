import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn();
const findById = vi.fn();
const findByUserId = vi.fn();
const upsertKycDetails = vi.fn();
const getPresignedPutUrl = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
    },
  },
}));

vi.mock("../../src/config/s3", () => ({ s3Bucket: "test-bucket" }));

vi.mock("../../src/repositories/user.repository", () => ({
  userRepository: {
    findById: (...args: unknown[]) => findById(...args),
  },
}));

vi.mock("../../src/repositories/agencyAgentApplication.repository", () => ({
  agencyAgentApplicationRepository: {
    findByUserId: (...args: unknown[]) => findByUserId(...args),
  },
}));

vi.mock("../../src/repositories/agencyApplicationKyc.repository", () => ({
  agencyApplicationKycRepository: {
    upsertKycDetails: (...args: unknown[]) => upsertKycDetails(...args),
  },
}));

vi.mock("../../src/repositories/agency.repository", () => ({
  agencyRepository: { getAgencyByUserId: vi.fn().mockResolvedValue(null) },
}));

vi.mock("../../src/services/agencyCoinseller.service", () => ({
  agencyCoinsellerService: { syncWhatsappFromKycPhone: vi.fn() },
}));

vi.mock("../../src/services/cacheRedis.service", () => ({
  cacheRedisService: { del: vi.fn(), delByKeyPrefix: vi.fn() },
}));

vi.mock("../../src/services/storage.service", () => ({
  storageService: {
    getPresignedPutUrl: (...args: unknown[]) => getPresignedPutUrl(...args),
    getCdnOrS3PublicUrl: (k: string) => `https://cdn/${k}`,
  },
}));

import {
  agencyKycService,
  HOST_CANNOT_APPLY_MESSAGE,
} from "../../src/services/agencyKyc.service";

const HOST_ERROR = {
  statusCode: 409,
  code: "ALREADY_IN_AGENCY",
  message: HOST_CANNOT_APPLY_MESSAGE,
};

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ currentAgencyId: null });
  findById.mockResolvedValue({
    id: "u1",
    isAgent: false,
    currentAgencyId: null,
    agencyBarredAt: null,
  });
  findByUserId.mockResolvedValue(null);
  getPresignedPutUrl.mockResolvedValue("https://s3/put");
});

describe("agencyKycService host guard", () => {
  it("blocks a host from applying, with the user-facing message", async () => {
    userFindUnique.mockResolvedValue({ currentAgencyId: "agent-9" });
    await expect(agencyKycService.applyForAgency("u1")).rejects.toMatchObject(HOST_ERROR);
  });

  it("blocks a host from starting the govt ID upload", async () => {
    userFindUnique.mockResolvedValue({ currentAgencyId: "agent-9" });
    await expect(
      agencyKycService.getPresignedGovtIdUrl("u1", "image/png"),
    ).rejects.toMatchObject(HOST_ERROR);
    expect(getPresignedPutUrl).not.toHaveBeenCalled();
  });

  it("blocks a host from submitting contact info", async () => {
    userFindUnique.mockResolvedValue({ currentAgencyId: "agent-9" });
    await expect(
      agencyKycService.submitContactInfo("u1", { phone: "+911234567", email: "a@b.co" }),
    ).rejects.toMatchObject(HOST_ERROR);
    expect(upsertKycDetails).not.toHaveBeenCalled();
  });

  it("does not gate the admin govt ID path", async () => {
    userFindUnique.mockResolvedValue({ currentAgencyId: "agent-9" });
    const res = await agencyKycService.getPresignedGovtIdUrl("u1", "image/png", {
      admin: true,
    });
    expect(res.uploadUrl).toBe("https://s3/put");
  });

  it("lets a non-host start the govt ID upload", async () => {
    const res = await agencyKycService.getPresignedGovtIdUrl("u1", "image/png");
    expect(res.uploadUrl).toBe("https://s3/put");
  });

  it("never uses 401, which ol_app treats as an expired session", async () => {
    userFindUnique.mockResolvedValue({ currentAgencyId: "agent-9" });
    await expect(agencyKycService.assertNotHostInAgency("u1")).rejects.not.toMatchObject({
      statusCode: 401,
    });
  });
});
