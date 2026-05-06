import type { RegisteredSocket } from './connection-registry'

export type RoomSocket = RegisteredSocket

/**
 * Sockets that successfully JOINed a conversation on this instance (membership verified at JOIN).
 */
class ConversationRooms {
  private readonly convToSockets = new Map<string, Map<string, RoomSocket>>()

  /** socketKey = socketId — one entry per physical socket. Returns true if this socket was not yet in the room (caller should bump Redis channel refcount). */
  join(conversationId: string, socketKey: string, rs: RoomSocket): boolean {
    let inner = this.convToSockets.get(conversationId)
    if (!inner) {
      inner = new Map()
      this.convToSockets.set(conversationId, inner)
    }
    const firstJoinForSocket = !inner.has(socketKey)
    inner.set(socketKey, rs)
    return firstJoinForSocket
  }

  /** Returns true if the socket was present (caller should decrement Redis channel refcount). */
  leave(conversationId: string, socketKey: string): boolean {
    const inner = this.convToSockets.get(conversationId)
    if (!inner || !inner.has(socketKey)) return false
    inner.delete(socketKey)
    if (inner.size === 0) this.convToSockets.delete(conversationId)
    return true
  }

  leaveAllForSocket(socketKey: string): string[] {
    const emptied: string[] = []
    for (const [convId, inner] of this.convToSockets) {
      if (inner.has(socketKey)) {
        inner.delete(socketKey)
        emptied.push(convId)
        if (inner.size === 0) this.convToSockets.delete(convId)
      }
    }
    return emptied
  }

  getSockets(conversationId: string): RoomSocket[] {
    const inner = this.convToSockets.get(conversationId)
    if (!inner) return []
    return [...inner.values()]
  }

  hasConversation(conversationId: string): boolean {
    const inner = this.convToSockets.get(conversationId)
    return inner !== undefined && inner.size > 0
  }

  /** How many distinct conversations this socket has JOINed. */
  joinedConversationCount(socketKey: string): number {
    let n = 0
    for (const inner of this.convToSockets.values()) {
      if (inner.has(socketKey)) n++
    }
    return n
  }
}

export const conversationRooms = new ConversationRooms()
