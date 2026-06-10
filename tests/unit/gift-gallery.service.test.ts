import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const upsertGlobalGallery = vi.fn();
const findGlobalGallery = vi.fn();
const findHostProgress = vi.fn();
const findSectionItemForGalleryGift = vi.fn();
const upsertProgress = vi.fn();
const getHostCompletionSummary = vi.fn();

vi.mock("../../src/repositories/gift-gallery.repository", () => ({
  giftGalleryRepository: {
    upsertGlobalGallery: (...a: unknown[]) => upsertGlobalGallery(...a),
    findGlobalGallery: (...a: unknown[]) => findGlobalGallery(...a),
    findHostProgress: (...a: unknown[]) => findHostProgress(...a),
    findSectionItemForGalleryGift: (...a: unknown[]) =>
      findSectionItemForGalleryGift(...a),
    upsertProgress: (...a: unknown[]) => upsertProgress(...a),
    getHostCompletionSummary: (...a: unknown[]) => getHostCompletionSummary(...a),
  },
}));

const assertAllActiveGiftIds = vi.fn();
vi.mock("../../src/repositories/gift.repository", () => ({
  giftRepository: {
    assertAllActiveGiftIds: (...a: unknown[]) => assertAllActiveGiftIds(...a),
  },
}));

const redisGet = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock("../../src/config/redis", () => ({
  redisClient: {
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
  },
  RedisKeys: {
    giftGalleryHost: (h: string, y: number, m: number) =>
      `gallery:${h}:${y}:${m}`,
    giftGalleryTemplate: (y: number, m: number) =>
      `gallery:template:${y}:${m}`,
  },
  GALLERY_HOST_TTL: 300,
  GALLERY_TEMPLATE_TTL: 600,
}));

import { giftGalleryService } from "../../src/services/gift-gallery.service";

describe("giftGalleryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAllActiveGiftIds.mockResolvedValue(undefined);
    upsertGlobalGallery.mockResolvedValue({ id: "gal-1" });
    redisDel.mockResolvedValue(1);
    redisSet.mockResolvedValue("OK");
    redisGet.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("upsertGallery validates gifts and upserts global gallery, deletes template key", async () => {
    await giftGalleryService.upsertGallery({
      year: 2026,
      month: 4,
      sections: [{ title: "A", sortOrder: 0, giftIds: ["00000000-0000-4000-8000-000000000001"] }],
    });
    expect(assertAllActiveGiftIds).toHaveBeenCalled();
    expect(upsertGlobalGallery).toHaveBeenCalledWith({
      year: 2026,
      month: 4,
      sections: [{ title: "A", sortOrder: 0, giftIds: ["00000000-0000-4000-8000-000000000001"] }],
    });
    expect(redisDel).toHaveBeenCalledWith("gallery:template:2026:4");
  });

  it("getGalleryForHost refreshes dynamic countdown fields on Redis hit without DB", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00.000Z"));
    const cached = {
      galleryId: "gal-1",
      hostUserId: "host-1",
      year: 2026,
      month: 4,
      monthEndAt: "2026-04-30T23:59:59.999Z",
      secondsRemaining: 10,
      isFullGallery: false,
      receivedItems: 0,
      totalItems: 1,
      sections: [],
    };
    redisGet.mockResolvedValueOnce(JSON.stringify(cached));
    const out = await giftGalleryService.getGalleryForHost("host-1");
    expect(out).toEqual({
      ...cached,
      secondsRemaining: 1339199,
    });
    expect(findGlobalGallery).not.toHaveBeenCalled();
  });

  it("getGalleryForHost miss with no global gallery returns empty shell", async () => {
    findGlobalGallery.mockResolvedValue(null);
    const out = await giftGalleryService.getGalleryForHost("host-1");
    expect(out.galleryId).toBeNull();
    expect(out.sections).toEqual([]);
    expect(out.isFullGallery).toBe(false);
    expect(out.receivedItems).toBe(0);
    expect(out.totalItems).toBe(0);
    expect(redisSet).toHaveBeenCalled();
  });

  it("recordGiftProgress upserts and invalidates host cache when created", async () => {
    findGlobalGallery.mockResolvedValue({
      id: "gal-1",
      year: 2026,
      month: 4,
      sections: [],
    });
    findSectionItemForGalleryGift.mockResolvedValue({ id: "item-1" });
    upsertProgress.mockResolvedValue({ created: true });
    getHostCompletionSummary.mockResolvedValue({
      totalItems: 2,
      receivedItems: 2,
      isFullGallery: true,
    });
    const r = await giftGalleryService.recordGiftProgress({
      hostUserId: "host-1",
      giftId: "gift-1",
      senderId: "sender-1",
    });
    expect(r.created).toBe(true);
    expect(r.galleryNowFull).toBe(true);
    expect(redisDel).toHaveBeenCalled();
  });

  it("recordGiftProgress skips cache delete when upsert not created", async () => {
    findGlobalGallery.mockResolvedValue({
      id: "gal-1",
      year: 2026,
      month: 4,
      sections: [],
    });
    findSectionItemForGalleryGift.mockResolvedValue({ id: "item-1" });
    upsertProgress.mockResolvedValue({ created: false });
    redisDel.mockClear();
    const r = await giftGalleryService.recordGiftProgress({
      hostUserId: "host-1",
      giftId: "gift-1",
      senderId: "sender-1",
    });
    expect(r.created).toBe(false);
    expect(redisDel).not.toHaveBeenCalled();
  });

  it("recordGiftProgress no-op when gift not in gallery", async () => {
    findGlobalGallery.mockResolvedValue({
      id: "gal-1",
      year: 2026,
      month: 4,
      sections: [],
    });
    findSectionItemForGalleryGift.mockResolvedValue(null);
    const r = await giftGalleryService.recordGiftProgress({
      hostUserId: "host-1",
      giftId: "gift-1",
      senderId: "sender-1",
    });
    expect(upsertProgress).not.toHaveBeenCalled();
    expect(r.created).toBe(false);
  });

  it("getCompletionSummaryForUser parses warm host cache", async () => {
    redisGet.mockResolvedValueOnce(
      JSON.stringify({
        receivedItems: 2,
        totalItems: 3,
        isFullGallery: false,
      }),
    );
    const s = await giftGalleryService.getCompletionSummaryForUser("u1");
    expect(s.receivedItems).toBe(2);
    expect(s.totalItems).toBe(3);
    expect(s.isFullGallery).toBe(false);
    expect(getHostCompletionSummary).not.toHaveBeenCalled();
  });

  it("checkIsFull returns received and remaining gift lists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00.000Z"));
    redisGet.mockResolvedValueOnce(
      JSON.stringify({
        galleryId: "gal-1",
        hostUserId: "host-1",
        year: 2026,
        month: 4,
        monthEndAt: "2026-04-30T23:59:59.999Z",
        secondsRemaining: 123,
        isFullGallery: false,
        receivedItems: 1,
        totalItems: 2,
        sections: [
          {
            id: "s-1",
            name: "Main",
            sortOrder: 0,
            totalGifts: 2,
            receivedGifts: 1,
            gifts: [
              {
                itemId: "i-1",
                giftId: "g-1",
                name: "Rose",
                imageUrl: "https://cdn/r.png",
                coinCost: 100,
                received: true,
                receivedAt: "2026-04-10T10:00:00.000Z",
                firstGifter: {
                  userId: "sender-1",
                  publicId: "34216590",
                  username: "sender",
                  firstName: "First",
                  lastName: "Sender",
                  avatarUrl: "https://cdn/a.png",
                },
              },
              {
                itemId: "i-2",
                giftId: "g-2",
                name: "Diamond",
                imageUrl: "https://cdn/d.png",
                coinCost: 200,
                received: false,
                receivedAt: null,
                firstGifter: null,
              },
            ],
          },
        ],
      }),
    );

    const out = await giftGalleryService.checkIsFull("host-1");
    expect(out.isFullGallery).toBe(false);
    expect(out.secondsRemaining).toBe(1339199);
    expect(out.receivedGifts).toHaveLength(1);
    expect(out.remainingGifts).toHaveLength(1);
    expect(out.receivedGifts[0]).toMatchObject({ giftId: "g-1" });
    expect(out.receivedGifts[0]).toMatchObject({
      firstSender: {
        userId: "sender-1",
        publicId: "34216590",
        avatarUrl: "https://cdn/a.png",
      },
    });
    expect(out.remainingGifts[0]).toMatchObject({ giftId: "g-2" });
  });
});
