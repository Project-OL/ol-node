import { RedisKeys } from "../../config/redis";
import { cacheRedisService } from "../cacheRedis.service";
import { meService } from "../me.service";

export async function bustLivePhotoCaches(userId: string): Promise<void> {
  await cacheRedisService.del(
    RedisKeys.livePhotoProfile(userId),
    RedisKeys.livePhotoVerifyStatus(userId),
  );
  await meService.invalidateUserCaches(userId);
}
