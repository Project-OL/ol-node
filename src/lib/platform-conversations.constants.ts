import type { MessageType } from '@prisma/client'

/** Platform inbox conversation types (one thread per user per type). */
export const PLATFORM_CONVERSATION_TYPES = ['SYSTEM', 'NOTIFICATION', 'TRANSACTIONAL'] as const

export type PlatformConversationType = (typeof PLATFORM_CONVERSATION_TYPES)[number]

export function isPlatformConversationType(type: string): type is PlatformConversationType {
  return (PLATFORM_CONVERSATION_TYPES as readonly string[]).includes(type)
}

export function messageTypeToPlatformConversationType(
  type: Extract<MessageType, 'SYSTEM' | 'NOTIFICATION' | 'TRANSACTIONAL'>,
): PlatformConversationType {
  return type
}
