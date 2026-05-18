import { describe, it, expect, vi, beforeEach } from "vitest";

const getById = vi.fn();
const cancelPending = vi.fn();
const removeJob = vi.fn();
const transaction = vi.fn();
const onAgencyMutation = vi.fn();
const delCache = vi.fn();

vi.mock("../../src/repositories/agencyLeaveApplication.repository", () => ({
  agencyLeaveApplicationRepository: {
    getById: (...a: unknown[]) => getById(...a),
    cancelPending: (...a: unknown[]) => cancelPending(...a),
  },
}));

vi.mock("../../src/services/agency.service", () => ({
  agencyService: {
    onAgencyMutation: (...a: unknown[]) => onAgencyMutation(...a),
  },
}));

vi.mock("../../src/queues/agency.queue", () => ({
  removeLeaveAutoApproveJob: (...a: unknown[]) => removeJob(...a),
}));

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => transaction(...a),
  },
  prismaRead: {},
}));

vi.mock("../../src/services/cacheRedis.service", () => ({
  cacheRedisService: {
    del: (...a: unknown[]) => delCache(...a),
  },
}));

import { agencyHostService } from "../../src/services/agencyHost.service";

const HOST_ID = "host-1";
const APP_ID = "leave-app-1";
const AGENCY_ID = "agency-1";

beforeEach(() => {
  vi.clearAllMocks();
  getById.mockResolvedValue({
    id: APP_ID,
    hostUserId: HOST_ID,
    agencyUserId: AGENCY_ID,
    status: "PENDING",
  });
  cancelPending.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
  );
});

describe("cancelLeaveApplication", () => {
  it("cancels PENDING leave, removes job, busts cache", async () => {
    const result = await agencyHostService.cancelLeaveApplication(HOST_ID, APP_ID);

    expect(removeJob).toHaveBeenCalledWith(APP_ID);
    expect(cancelPending).toHaveBeenCalledWith(APP_ID, HOST_ID, expect.anything());
    expect(delCache).toHaveBeenCalled();
    expect(onAgencyMutation).toHaveBeenCalledWith(AGENCY_ID);
    expect(result.ok).toBe(true);
    expect(result.cancelledAt).toBeDefined();
  });

  it("404 when not owner", async () => {
    getById.mockResolvedValue({
      id: APP_ID,
      hostUserId: "other",
      status: "PENDING",
    });
    await expect(
      agencyHostService.cancelLeaveApplication(HOST_ID, APP_ID),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("409 when not PENDING", async () => {
    getById.mockResolvedValue({
      id: APP_ID,
      hostUserId: HOST_ID,
      status: "APPROVED",
    });
    await expect(
      agencyHostService.cancelLeaveApplication(HOST_ID, APP_ID),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE" });
  });

  it("409 when race loses update", async () => {
    cancelPending.mockResolvedValue({ count: 0 });
    await expect(
      agencyHostService.cancelLeaveApplication(HOST_ID, APP_ID),
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE" });
  });
});
