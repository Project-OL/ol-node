import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/middlewares/errorHandler";

const getAgencyByPublicId = vi.fn();
const getRecentExitForHost = vi.fn();
const findLatestRejectedApplication = vi.fn();
const createAcceptedApplication = vi.fn();
const insertHost = vi.fn();
const incrementHostCount = vi.fn();
const enforcePauseGate = vi.fn();
const onAgencyMutation = vi.fn();
const cacheDel = vi.fn();
const userFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock("../../src/repositories/agency.repository", () => ({
  agencyRepository: {
    getAgencyByPublicId: (...args: unknown[]) => getAgencyByPublicId(...args),
    incrementHostCount: (...args: unknown[]) => incrementHostCount(...args),
  },
}));

vi.mock("../../src/repositories/agencyApplication.repository", () => ({
  agencyApplicationRepository: {
    createAcceptedApplication: (...args: unknown[]) =>
      createAcceptedApplication(...args),
  },
}));

vi.mock("../../src/repositories/agencyHost.repository", () => ({
  agencyHostRepository: {
    getRecentExitForHost: (...args: unknown[]) => getRecentExitForHost(...args),
    findLatestRejectedApplication: (...args: unknown[]) =>
      findLatestRejectedApplication(...args),
    insertHost: (...args: unknown[]) => insertHost(...args),
  },
}));

vi.mock("../../src/services/agency.service", () => ({
  agencyService: {
    enforcePauseGate: (...args: unknown[]) => enforcePauseGate(...args),
    onAgencyMutation: (...args: unknown[]) => onAgencyMutation(...args),
  },
}));

vi.mock("../../src/services/cacheRedis.service", () => ({
  cacheRedisService: {
    del: (...args: unknown[]) => cacheDel(...args),
  },
}));

vi.mock("../../src/config/database", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import { agencyHostService } from "../../src/services/agencyHost.service";

beforeEach(() => {
  vi.clearAllMocks();
  getAgencyByPublicId.mockResolvedValue({
    userId: "agent-1",
    defaultPublicId: 34216592n,
  });
  userFindUnique.mockResolvedValue({
    id: "host-1",
    currentAgencyId: null,
    isAgent: false,
  });
  getRecentExitForHost.mockResolvedValue(null);
  findLatestRejectedApplication.mockResolvedValue(null);
  enforcePauseGate.mockResolvedValue(undefined);
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      user: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    return fn(tx);
  });
  createAcceptedApplication.mockResolvedValue({ id: "app-1" });
  insertHost.mockResolvedValue({});
  incrementHostCount.mockResolvedValue({});
});

describe("agencyHostService.applyToAgency (instant join)", () => {
  it("returns immediate true and finalizes membership in one transaction", async () => {
    const result = await agencyHostService.applyToAgency(
      "host-1",
      "34216592",
      "hello",
    );

    expect(result).toEqual({ ok: true, immediate: true });
    expect(createAcceptedApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        agencyUserId: "agent-1",
        hostUserId: "host-1",
        message: "hello",
      }),
      expect.anything(),
    );
    expect(insertHost).toHaveBeenCalled();
    expect(incrementHostCount).toHaveBeenCalledWith("agent-1", 1, expect.anything());
    expect(cacheDel).toHaveBeenCalled();
    expect(onAgencyMutation).toHaveBeenCalledWith("agent-1");
  });

  it("rejects when host already in an agency", async () => {
    userFindUnique.mockResolvedValue({
      id: "host-1",
      currentAgencyId: "other-agent",
      isAgent: false,
    });

    await expect(
      agencyHostService.applyToAgency("host-1", "34216592"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ALREADY_IN_AGENCY",
    });
  });

  it("rejects when agency is paused", async () => {
    enforcePauseGate.mockRejectedValue(
      new AppError(403, "Agency is paused", "AGENCY_PAUSED"),
    );

    await expect(
      agencyHostService.applyToAgency("host-1", "34216592"),
    ).rejects.toMatchObject({ code: "AGENCY_PAUSED" });
  });
});
