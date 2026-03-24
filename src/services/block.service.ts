import { blockRepository } from '../repositories/block.repository'
import { cacheService } from './cache.service'
import { auditService } from '../services/audit.service'
import { AppError } from '../middlewares/errorHandler'
import { RedisKeys, BLOCK_LIST_TTL } from '../config/redis'
import type { GetBlockListInput } from '../models/messaging.schemas'

export type PaginatedBlockList = Awaited<
  ReturnType<typeof blockRepository.getBlockList>
>

export const blockService = {
  async blockUser(blockerId: string, blockedId: string): Promise<void> {
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
      actionDetails: { blockedId },
    })
  },

  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
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
      actionDetails: { blockedId },
    })
  },

  async bulkUnblock(
    blockerId: string,
    blockedIds: string[],
  ): Promise<{ count: number }> {
    if (blockedIds.length > 50) {
      throw new AppError(
        400,
        'Max 50 users per bulk unblock',
        'INVALID_REQUEST',
      )
    }
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

  async getBlockList(
    blockerId: string,
    input: GetBlockListInput,
  ): Promise<PaginatedBlockList> {
    if (!input.search && !input.cursor) {
      const cached = await cacheService.get(RedisKeys.blockList(blockerId))
      if (cached) {
        return JSON.parse(cached) as PaginatedBlockList
      }
    }
    const result = await blockRepository.getBlockList(
      blockerId,
      input.search,
      input.cursor,
      input.limit,
    )
    if (!input.search && !input.cursor) {
      await cacheService.set(
        RedisKeys.blockList(blockerId),
        JSON.stringify(result),
        BLOCK_LIST_TTL,
      )
    }
    return result
  },
}
