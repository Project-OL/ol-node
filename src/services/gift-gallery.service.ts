import { redisClient, RedisKeys } from "../config/redis";
import { GIFT_GALLERY_CACHE_TTL } from "../config/redis";
import { giftGalleryRepository } from "../repositories/gift-gallery.repository";
import { giftRepository } from "../repositories/gift.repository";
import { AppError } from "../middlewares/errorHandler";
import { getMonthEnd, getPeriodKeys } from "../utils/periodKeys";

function buildGalleryPayload(
  gallery: NonNullable<
    Awaited<ReturnType<typeof giftGalleryRepository.findByHostYearMonth>>
  >,
) {
  const { year, month } = gallery;
  const monthEndAt = getMonthEnd(year, month);
  const now = new Date();
  const secondsRemaining = Math.max(
    0,
    Math.floor((monthEndAt.getTime() - now.getTime()) / 1000),
  );

  const progressByGift = new Map(
    gallery.progress.map((p) => [
      p.giftId,
      {
        firstGifterUserId: p.firstGifterUserId,
        firstGifterUsername: p.firstGifter.username,
        firstGifterAvatarUrl: p.firstGifter.avatarUrl,
        receivedAt: p.receivedAt.toISOString(),
      },
    ]),
  );

  let totalGiftsAll = 0;
  const sections = gallery.sections.map((s) => {
    const gifts = s.gifts.map((gi) => {
      totalGiftsAll += 1;
      const prog = progressByGift.get(gi.giftId);
      return {
        giftId: gi.gift.id,
        name: gi.gift.name,
        displayImageUrl: gi.gift.displayImageUrl,
        effectUrl: gi.gift.effectUrl,
        coinCost: gi.gift.coinCost,
        received: !!prog,
        firstGifterUserId: prog?.firstGifterUserId ?? null,
        firstGifterUsername: prog?.firstGifterUsername ?? null,
        firstGifterAvatarUrl: prog?.firstGifterAvatarUrl ?? null,
        receivedAt: prog?.receivedAt ?? null,
      };
    });
    const receivedGifts = gifts.filter((x) => x.received).length;
    return {
      id: s.id,
      title: s.title,
      sortOrder: s.sortOrder,
      totalGifts: gifts.length,
      receivedGifts,
      gifts,
    };
  });

  const isFullGallery =
    totalGiftsAll > 0 && gallery.progress.length >= totalGiftsAll;

  return {
    galleryId: gallery.id,
    hostUserId: gallery.hostUserId,
    year: gallery.year,
    month: gallery.month,
    monthEndAt: monthEndAt.toISOString(),
    secondsRemaining,
    isFullGallery,
    sections,
  };
}

export const giftGalleryService = {
  async upsertForHost(input: {
    hostUserId: string;
    year: number;
    month: number;
    sections: Array<{ title: string; sortOrder: number; giftIds: string[] }>;
  }) {
    const allIds = input.sections.flatMap((s) => s.giftIds);
    try {
      await giftRepository.assertAllActiveGiftIds(allIds);
    } catch {
      throw new AppError(
        400,
        "One or more gifts are missing or inactive",
        "INVALID_GIFT_IDS",
      );
    }

    await giftGalleryRepository.replaceGallerySections({
      hostUserId: input.hostUserId,
      year: input.year,
      month: input.month,
      sections: input.sections,
    });

    try {
      await redisClient.del(
        RedisKeys.giftGallery(input.hostUserId, input.year, input.month),
      );
    } catch {
      // ignore
    }

    return { ok: true };
  },

  async getForHostCurrentMonth(hostUserId: string) {
    const { year, month } = getPeriodKeys();
    const cacheKey = RedisKeys.giftGallery(hostUserId, year, month);

    try {
      const raw = await redisClient.get(cacheKey);
      if (raw) return JSON.parse(raw) as ReturnType<typeof buildGalleryPayload>;
    } catch {
      // cold path
    }

    const gallery = await giftGalleryRepository.findByHostYearMonth(
      hostUserId,
      year,
      month,
    );

    if (!gallery) {
      const monthEndAt = getMonthEnd(year, month);
      const now = new Date();
      const secondsRemaining = Math.max(
        0,
        Math.floor((monthEndAt.getTime() - now.getTime()) / 1000),
      );
      const empty = {
        galleryId: null,
        hostUserId,
        year,
        month,
        monthEndAt: monthEndAt.toISOString(),
        secondsRemaining,
        isFullGallery: false,
        sections: [] as unknown[],
      };
      try {
        await redisClient.set(
          cacheKey,
          JSON.stringify(empty),
          "EX",
          GIFT_GALLERY_CACHE_TTL,
        );
      } catch {
        // ignore
      }
      return empty;
    }

    const payload = buildGalleryPayload(gallery);
    try {
      await redisClient.set(
        cacheKey,
        JSON.stringify(payload),
        "EX",
        GIFT_GALLERY_CACHE_TTL,
      );
    } catch {
      // ignore
    }
    return payload;
  },

  async checkFull(hostUserId: string) {
    const full = await this.getForHostCurrentMonth(hostUserId);
    return {
      isFullGallery: full.isFullGallery,
      secondsRemaining: full.secondsRemaining,
    };
  },

  /** Invalidate cached gallery for receiver after a gift send. */
  async invalidateHostMonthCache(hostUserId: string, year: number, month: number) {
    try {
      await redisClient.del(RedisKeys.giftGallery(hostUserId, year, month));
    } catch {
      // ignore
    }
  },
};
