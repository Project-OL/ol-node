import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'

const PAGE = 5_000

/**
 * Redis `vip:reserved` sync from Postgres. Pool sorted sets / meta hashes were removed — rare IDs are store-only.
 */
export const vipPoolService = {
  /**
   * Rebuild `vip:reserved` from all catalog rows (paginated). Safe to run after Redis flush.
   */
  async warmReservedSet(): Promise<void> {
    let skip = 0
    for (;;) {
      const rows = await prisma.vipPublicId.findMany({
        select: { publicId: true },
        orderBy: { publicId: 'asc' },
        skip,
        take: PAGE,
      })
      if (rows.length === 0) break

      const pipeline = redisClient.pipeline()
      for (const row of rows) {
        pipeline.sadd(RedisKeys.vipReserved(), row.publicId.toString())
      }
      try {
        await pipeline.exec()
      } catch (err) {
        console.error('[vip-pool] Redis pipeline failed in warmReservedSet()', err)
      }
      skip += rows.length
    }
  },
}
