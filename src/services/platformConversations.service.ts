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

export const platformConversationsService = {
  /**
   * Creates three empty platform inbox threads for a newly registered user.
   * No-op for existing users unless called explicitly; safe to call multiple times.
   */
  async provisionForNewUser(userId: string): Promise<void> {
    const sender = await getOrCreatePlatformSenderUser()
    if (userId === sender.id) return

    const created: string[] = []
    for (const type of PLATFORM_CONVERSATION_TYPES) {
      const existing = await conversationRepository.findPlatformConversationForUser(userId, type)
      if (existing) continue

      const conv = await conversationRepository.createPlatformConversation({
        type,
        userId,
        platformSenderUserId: sender.id,
      })
      created.push(conv.id)
    }

    if (created.length > 0) {
      await cacheService.delete(RedisKeys.userConversations(userId))
      log.info({ userId, conversationIds: created }, 'provisioned platform inbox conversations')
    }
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

    const conv = await conversationRepository.createPlatformConversation({
      type: conversationType,
      userId,
      platformSenderUserId: sender.id,
    })
    await cacheService.delete(RedisKeys.userConversations(userId))
    return { conversationId: conv.id, platformSenderUserId: sender.id }
  },
}
