import { conversationRepository } from '../repositories/conversation.repository'
import { cacheService } from './cache.service'
import { RedisKeys } from '../config/redis'
import {
  PLATFORM_CONVERSATION_TYPES,
  type PlatformConversationType,
} from '../lib/platform-conversations.constants'
import { getOrCreatePlatformSenderUser } from './platformSender.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'platform-conversations' })

export type PlatformProvisionResult = {
  created: string[]
  reactivated: string[]
}

export const platformConversationsService = {
  /**
   * Creates three empty platform inbox threads for a newly registered user.
   * Idempotent: skips types that already have an active membership; reactivates
   * soft-deleted memberships instead of creating duplicates.
   */
  async provisionForNewUser(userId: string): Promise<PlatformProvisionResult> {
    const sender = await getOrCreatePlatformSenderUser()
    if (userId === sender.id) return { created: [], reactivated: [] }

    const created: string[] = []
    const reactivated: string[] = []

    for (const type of PLATFORM_CONVERSATION_TYPES) {
      const active = await conversationRepository.findPlatformConversationForUser(userId, type)
      if (active) continue

      const dormant = await conversationRepository.findPlatformConversationForUser(userId, type, {
        includeDeletedMembership: true,
      })
      if (dormant) {
        const ok = await conversationRepository.reactivateMember(dormant.id, userId)
        if (ok) reactivated.push(dormant.id)
        continue
      }

      const conv = await conversationRepository.createPlatformConversation({
        type,
        userId,
        platformSenderUserId: sender.id,
      })
      created.push(conv.id)
    }

    if (created.length > 0 || reactivated.length > 0) {
      await cacheService.delete(RedisKeys.userConversations(userId))
      log.info(
        { userId, conversationIds: created, reactivated },
        'provisioned platform inbox conversations',
      )
    }

    return { created, reactivated }
  },

  /** Resolve the typed platform thread; lazy-create for legacy users on first message. */
  async resolveForMessage(
    userId: string,
    conversationType: PlatformConversationType,
  ): Promise<{ conversationId: string; platformSenderUserId: string }> {
    const sender = await getOrCreatePlatformSenderUser()

    const existing = await conversationRepository.findPlatformConversationForUser(
      userId,
      conversationType,
    )
    if (existing) {
      return { conversationId: existing.id, platformSenderUserId: sender.id }
    }

    const dormant = await conversationRepository.findPlatformConversationForUser(
      userId,
      conversationType,
      { includeDeletedMembership: true },
    )
    if (dormant) {
      await conversationRepository.reactivateMember(dormant.id, userId)
      await cacheService.delete(RedisKeys.userConversations(userId))
      return { conversationId: dormant.id, platformSenderUserId: sender.id }
    }

    const conv = await conversationRepository.createPlatformConversation({
      type: conversationType,
      userId,
      platformSenderUserId: sender.id,
    })
    await cacheService.delete(RedisKeys.userConversations(userId))
    return { conversationId: conv.id, platformSenderUserId: sender.id }
  },
}
