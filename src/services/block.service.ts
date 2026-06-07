import { blockRepository } from '../repositories/block.repository'
import { userRepository } from '../repositories/user.repository'
import { cacheService } from './cache.service'
import { auditService } from '../services/audit.service'
import { AppError } from '../middlewares/errorHandler'
import { RedisKeys, BLOCK_LIST_TTL } from '../config/redis'
import type { GetBlockListInput } from '../models/messaging.schemas'

export type BlockListItem = {
  id: string
  blockerId: string
  blockedId: string
  createdAt: Date
  blocked: {
    id: string
    username: string
    defaultPublicId: string
    /** Display URL for the blocked user’s avatar (same as User.avatarUrl). */
    avatarUrl: string | null
  }
}

export type PaginatedBlockList = {
  blocks: BlockListItem[]
  nextCursor: string | null
}

/**
 * First-page list is cached without a limit in the key. If the client asks for a
 * smaller limit than what was cached (e.g. cache from default 20, request limit=2),
 * return only the first `limit` rows and a cursor for the next page.
 */
function sliceBlockListFromCache(cached: PaginatedBlockList, limit: number): PaginatedBlockList {
  const rows = cached.blocks
  if (rows.length === 0) {
    return { blocks: [], nextCursor: null }
  }
  if (rows.length <= limit) {
    return {
      blocks: rows,
      nextCursor: cached.nextCursor ?? null,
    }
  }
  const page = rows.slice(0, limit)
  const nextCursor = page[limit - 1]?.id ?? null
  return { blocks: page, nextCursor }
}

async function resolveBlockedTarget(publicId: string): Promise<{
  userId: string
  canonicalPublicId: string
}> {
  const numericId = Number(publicId)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
  }
  const user = await userRepository.findByPublicId(numericId)
  if (!user) {
    throw new AppError(404, 'User not found', 'NOT_FOUND')
  }
  return { userId: user.id, canonicalPublicId: user.publicId.toString() }
}

export const blockService = {
  async blockUser(blockerId: string, blockedPublicId: string): Promise<void> {
    const { userId: blockedId } = await resolveBlockedTarget(blockedPublicId)
    if (blockerId === blockedId) {
      throw new AppError(400, 'Cannot block yourself', 'INVALID_REQUEST')
    }
    const existing = await blockRepository.findBlock(blockerId, blockedId)
    if (existing) {
      throw new AppError(409, 'Already blocked', 'ALREADY_BLOCKED')
    }
    await blockRepository.blockUser(blockerId, blockedId)
    await cacheService.delete(RedisKeys.blockList(blockerId))
    await auditService.log({
      actionType: 'BLOCK_USER',
      actionStatus: 'success',
      userId: blockerId,
      actionDetails: { blockedPublicId },
    })
  },

  async unblockUser(blockerId: string, blockedPublicId: string): Promise<void> {
    const { userId: blockedId } = await resolveBlockedTarget(blockedPublicId)
    const existing = await blockRepository.findBlock(blockerId, blockedId)
    if (!existing) {
      throw new AppError(404, 'Block not found', 'BLOCK_NOT_FOUND')
    }
    await blockRepository.unblockUser(blockerId, blockedId)
    await cacheService.delete(RedisKeys.blockList(blockerId))
    await auditService.log({
      actionType: 'UNBLOCK_USER',
      actionStatus: 'success',
      userId: blockerId,
      actionDetails: { blockedPublicId },
    })
  },

  async bulkUnblock(blockerId: string, blockedPublicIds: string[]): Promise<{ count: number }> {
    if (blockedPublicIds.length > 50) {
      throw new AppError(400, 'Max 50 users per bulk unblock', 'INVALID_REQUEST')
    }
    const blockedIds = await Promise.all(
      blockedPublicIds.map(async (pid) => (await resolveBlockedTarget(pid)).userId),
    )
    const result = await blockRepository.bulkUnblock(blockerId, blockedIds)
    await cacheService.delete(RedisKeys.blockList(blockerId))
    await auditService.log({
      actionType: 'BULK_UNBLOCK',
      actionStatus: 'success',
      userId: blockerId,
      actionDetails: { count: result.count },
    })
    return result
  },

  async checkBlock(
    blockerId: string,
    targetPublicId: string,
  ): Promise<{ isBlocked: boolean; publicId: string }> {
    const { userId: targetId, canonicalPublicId } = await resolveBlockedTarget(targetPublicId)
    const existing = await blockRepository.findBlock(blockerId, targetId)
    return { isBlocked: existing !== null, publicId: canonicalPublicId }
  },

  async getBlockList(blockerId: string, input: GetBlockListInput): Promise<PaginatedBlockList> {
    if (!input.search && !input.cursor) {
      const cached = await cacheService.get(RedisKeys.blockList(blockerId))
      if (cached) {
        const parsed = JSON.parse(cached) as PaginatedBlockList
        return sliceBlockListFromCache(parsed, input.limit)
      }
    }
    const raw = await blockRepository.getBlockList(
      blockerId,
      input.search,
      input.cursor,
      input.limit,
    )
    const result: PaginatedBlockList = {
      blocks: raw.blocks.map((b) => ({
        id: b.id,
        blockerId: b.blockerId,
        blockedId: b.blockedId,
        createdAt: b.createdAt,
        blocked: {
          id: b.blocked.id,
          username: b.blocked.username,
          defaultPublicId: b.blocked.defaultPublicId,
          avatarUrl: b.blocked.avatarUrl ?? null,
        },
      })),
      nextCursor: raw.nextCursor,
    }
    if (!input.search && !input.cursor) {
      await cacheService.set(RedisKeys.blockList(blockerId), JSON.stringify(result), BLOCK_LIST_TTL)
    }
    return result
  },
}
