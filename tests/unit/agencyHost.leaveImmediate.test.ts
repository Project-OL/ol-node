import { describe, it, expect, vi, beforeEach } from "vitest";

const getHost = vi.fn();
const getPendingForHost = vi.fn();
const findLatestResolvedLeaveApplication = vi.fn();
const kycFindUnique = vi.fn();
const faceProfileFindUnique = vi.fn();
const finalizeExit = vi.fn();
const transaction = vi.fn();
const onAgencyMutation = vi.fn();
const createLeave = vi.fn();
const enqueueLeave = vi.fn();

vi.mock("../../src/repositories/agencyHost.repository", () => ({
  agencyHostRepository: {
    getHost: (...a: unknown[]) => getHost(...a),
    findLatestResolvedLeaveApplication: (...a: unknown[]) =>
      findLatestResolvedLeaveApplication(...a),
    insertHistory: vi.fn(),
    removeHost: vi.fn(),
  },
}));

vi.mock("../../src/repositories/agencyLeaveApplication.repository", () => ({
  agencyLeaveApplicationRepository: {
    getPendingForHost: (...a: unknown[]) => getPendingForHost(...a),
    create: (...a: unknown[]) => createLeave(...a),
  },
}));

vi.mock("../../src/repositories/agency.repository", () => ({
  agencyRepository: {
    incrementHostCount: vi.fn(),
  },
}));

vi.mock("../../src/services/agency.service", () => ({
  agencyService: {
    enforcePauseGate: vi.fn(),
    onAgencyMutation: (...a: unknown[]) => onAgencyMutation(...a),
  },
}));

vi.mock("../../src/queues/agency.queue", () => ({
  enqueueLeaveAutoApprove: (...a: unknown[]) => enqueueLeave(...a),
  removeLeaveAutoApproveJob: vi.fn(),
}));

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => transaction(...a),
    user: { update: vi.fn() },
    agencyHost: { findUnique: vi.fn(), delete: vi.fn() },
    agencyHostHistory: { create: vi.fn() },
  },
  prismaRead: {
    agencyApplicationKyc: {
      findUnique: (...a: unknown[]) => kycFindUnique(...a),
    },
    userFaceProfile: {
      findUnique: (...a: unknown[]) => faceProfileFindUnique(...a),
    },
  },
}));

import { agencyHostService } from "../../src/services/agencyHost.service";

const HOST_ID = "host-1";
const AGENCY_ID = "agency-1";
const joinedThreeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  getPendingForHost.mockResolvedValue(null);
  findLatestResolvedLeaveApplication.mockResolvedValue(null);
  kycFindUnique.mockResolvedValue(null);
  faceProfileFindUnique.mockResolvedValue(null);
  getHost.mockResolvedValue({
    agencyUserId: AGENCY_ID,
    hostUserId: HOST_ID,
    joinedAt: joinedThreeDaysAgo,
  });
  const mockTx = {
    agencyHost: {
      findUnique: vi.fn().mockResolvedValue({
        agencyUserId: AGENCY_ID,
        hostUserId: HOST_ID,
        joinedAt: joinedThreeDaysAgo,
      }),
    },
    user: { update: vi.fn().mockResolvedValue({}) },
  };
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx));
  onAgencyMutation.mockResolvedValue(undefined);
});

describe("agencyHostService.applyToLeave immediate rules", () => {
  it("leaves immediately when face is not verified even after 24h", async () => {
    const result = await agencyHostService.applyToLeave(HOST_ID, "test");

    expect(result).toEqual({ ok: true, immediate: true });
    expect(transaction).toHaveBeenCalled();
    expect(createLeave).not.toHaveBeenCalled();
    expect(enqueueLeave).not.toHaveBeenCalled();
  });

  it("requires approval when face is verified and tenure >= 24h", async () => {
    kycFindUnique.mockResolvedValue({ faceVerified: true });
    createLeave.mockResolvedValue({
      id: "leave-1",
      autoApproveAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const result = await agencyHostService.applyToLeave(HOST_ID);

    expect(result.immediate).toBe(false);
    expect(createLeave).toHaveBeenCalled();
    expect(enqueueLeave).toHaveBeenCalled();
  });

  it("leaves immediately when tenure < 24h even if face verified", async () => {
    getHost.mockResolvedValue({
      agencyUserId: AGENCY_ID,
      hostUserId: HOST_ID,
      joinedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    faceProfileFindUnique.mockResolvedValue({ status: "INDEXED" });

    const result = await agencyHostService.applyToLeave(HOST_ID);

    expect(result).toEqual({ ok: true, immediate: true });
    expect(createLeave).not.toHaveBeenCalled();
  });
});
