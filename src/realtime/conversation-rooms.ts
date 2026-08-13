import type { RegisteredSocket } from './connection-registry'

export type RoomSocket = RegisteredSocket

/**
 * Sockets that successfully JOINed a conversation on this instance (membership verified at JOIN).
 */
class ConversationRooms {
  private readonly convToSockets = new Map<string, Map<string, RoomSocket>>()
  /** Reverse index: socketId -> conversation ids it has joined. Keeps leaveAllForSocket
   *  and joinedConversationCount O(rooms joined by this socket) instead of O(all rooms on the pod). */
  private readonly socketToConvs = new Map<string, Set<string>>()

  /** socketKey = socketId — one entry per physical socket. Returns true if this socket was not yet in the room (caller should bump Redis channel refcount). */
  join(conversationId: string, socketKey: string, rs: RoomSocket): boolean {
    let inner = this.convToSockets.get(conversationId)
    if (!inner) {
      inner = new Map()
      this.convToSockets.set(conversationId, inner)
    }
    const firstJoinForSocket = !inner.has(socketKey)
    inner.set(socketKey, rs)

    let convs = this.socketToConvs.get(socketKey)
    if (!convs) {
      convs = new Set()
      this.socketToConvs.set(socketKey, convs)
    }
    convs.add(conversationId)

    return firstJoinForSocket
  }

  /** Returns true if the socket was present (caller should decrement Redis channel refcount). */
  leave(conversationId: string, socketKey: string): boolean {
    const inner = this.convToSockets.get(conversationId)
    if (!inner || !inner.has(socketKey)) return false
    inner.delete(socketKey)
    if (inner.size === 0) this.convToSockets.delete(conversationId)

    const convs = this.socketToConvs.get(socketKey)
    if (convs) {
      convs.delete(conversationId)
      if (convs.size === 0) this.socketToConvs.delete(socketKey)
    }

    return true
  }

  leaveAllForSocket(socketKey: string): string[] {
    const convs = this.socketToConvs.get(socketKey)
    if (!convs) return []
    const emptied: string[] = []
    for (const convId of convs) {
      const inner = this.convToSockets.get(convId)
      if (inner?.has(socketKey)) {
        inner.delete(socketKey)
        emptied.push(convId)
        if (inner.size === 0) this.convToSockets.delete(convId)
      }
    }
    this.socketToConvs.delete(socketKey)
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
    return this.socketToConvs.get(socketKey)?.size ?? 0
  }
}

export const conversationRooms = new ConversationRooms()
