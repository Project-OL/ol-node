import { describe, it, expect, vi, beforeEach } from "vitest";

const agencyFindUnique = vi.fn();
const userFindFirst = vi.fn();

vi.mock("../../src/config/database", () => ({
  prismaRead: {
    agency: {
      findUnique: (...args: unknown[]) => agencyFindUnique(...args),
    },
    user: {
      findFirst: (...args: unknown[]) => userFindFirst(...args),
    },
  },
}));

import { agencyRepository } from "../../src/repositories/agency.repository";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agencyRepository.getAgencyByPublicId", () => {
  it("returns agency when id matches default_public_id", async () => {
    const agency = { userId: "owner-1", defaultPublicId: 34216592n };
    agencyFindUnique.mockResolvedValueOnce(agency);

    const result = await agencyRepository.getAgencyByPublicId(34216592n);

    expect(result).toBe(agency);
    expect(agencyFindUnique).toHaveBeenCalledWith({
      where: { defaultPublicId: 34216592n },
    });
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("resolves agency via owner VIP display public id", async () => {
    agencyFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        userId: "owner-1",
        defaultPublicId: 34216592n,
      });
    userFindFirst.mockResolvedValueOnce({ id: "owner-1" });

    const result = await agencyRepository.getAgencyByPublicId(34263426n);

    expect(result?.defaultPublicId).toBe(34216592n);
    expect(userFindFirst).toHaveBeenCalledWith({
      where: {
        isAgent: true,
        OR: [
          { publicId: 34263426n },
          { defaultPublicId: 34263426n },
          { currentVipPublicId: 34263426n },
        ],
      },
      select: { id: true },
    });
    expect(agencyFindUnique).toHaveBeenLastCalledWith({
      where: { userId: "owner-1" },
    });
  });

  it("returns null when no agency or agent owner matches", async () => {
    agencyFindUnique.mockResolvedValue(null);
    userFindFirst.mockResolvedValue(null);

    const result = await agencyRepository.getAgencyByPublicId(99999999n);

    expect(result).toBeNull();
  });
});
