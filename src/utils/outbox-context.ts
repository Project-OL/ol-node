import type { OutboxMember, OutboxSender } from '../services/messaging-outbox.service'

/**
 * Derives the outbox-publish context (member mute status, conversation type,
 * sender profile) from a conversation already loaded by
 * conversationRepository.findConversationById — the same data
 * publishMessageOutboxRow would otherwise re-fetch from Postgres. Filters
 * out isDeleted members to match that function's own `isDeleted: false`
 * filter (findConversationById's include does not filter deleted members).
 */
export function buildOutboxContext(
  conv: {
    type: string
    members: Array<{
      userId: string
      isMuted: boolean
      mutedUntil: Date | null
      isDeleted: boolean
      user: OutboxSender
    }>
  },
  senderId: string,
): { conversationType: string; members: OutboxMember[]; sender: OutboxSender | null } {
  const activeMembers = conv.members.filter((m) => !m.isDeleted)
  return {
    conversationType: conv.type,
    members: activeMembers.map((m) => ({
      userId: m.userId,
      isMuted: m.isMuted,
      mutedUntil: m.mutedUntil,
    })),
    sender: activeMembers.find((m) => m.userId === senderId)?.user ?? null,
  }
}
