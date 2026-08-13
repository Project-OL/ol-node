import type { RegisteredSocket } from './connection-registry'

/**
 * Sockets that subscribed to another user's (or own) guardian feed via JOIN_GUARDIAN
 * (Redis `guardian:user:{id}` refcount).
 */
class GuardianRooms {
  private readonly userToSockets = new Map<string, Map<string, RegisteredSocket>>()
  /** Reverse index: socketId -> target user ids it watches. Keeps leaveAllForSocket
   *  O(rooms joined by this socket) instead of O(all rooms on the pod). */
  private readonly socketToUsers = new Map<string, Set<string>>()

  /** Returns true if this socket was not yet subscribed (bump Redis channel refcount). */
  join(targetUserId: string, socketKey: string, rs: RegisteredSocket): boolean {
    let inner = this.userToSockets.get(targetUserId)
    if (!inner) {
      inner = new Map()
      this.userToSockets.set(targetUserId, inner)
    }
    const first = !inner.has(socketKey)
    inner.set(socketKey, rs)

    let users = this.socketToUsers.get(socketKey)
    if (!users) {
      users = new Set()
      this.socketToUsers.set(socketKey, users)
    }
    users.add(targetUserId)

    return first
  }

  leave(targetUserId: string, socketKey: string): boolean {
    const inner = this.userToSockets.get(targetUserId)
    if (!inner || !inner.has(socketKey)) return false
    inner.delete(socketKey)
    if (inner.size === 0) this.userToSockets.delete(targetUserId)

    const users = this.socketToUsers.get(socketKey)
    if (users) {
      users.delete(targetUserId)
      if (users.size === 0) this.socketToUsers.delete(socketKey)
    }

    return true
  }

  leaveAllForSocket(socketKey: string): string[] {
    const users = this.socketToUsers.get(socketKey)
    if (!users) return []
    const emptied: string[] = []
    for (const userId of users) {
      const inner = this.userToSockets.get(userId)
      if (inner?.has(socketKey)) {
        inner.delete(socketKey)
        emptied.push(userId)
        if (inner.size === 0) this.userToSockets.delete(userId)
      }
    }
    this.socketToUsers.delete(socketKey)
    return emptied
  }

  getSockets(targetUserId: string): RegisteredSocket[] {
    const inner = this.userToSockets.get(targetUserId)
    if (!inner) return []
    return [...inner.values()]
  }
}

export const guardianRooms = new GuardianRooms()
