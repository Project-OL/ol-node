import type { RegisteredSocket } from './connection-registry'

/**

 * Sockets subscribed to **`msg:user:{userId}`** for MESSAGE_DIGEST (Phase 7).

 */

class UserInboxRooms {
  private readonly userToSockets = new Map<string, Map<string, RegisteredSocket>>()
  /** Reverse index: socketId -> user ids it has an inbox subscription for. Keeps
   *  leaveAllForSocket O(rooms joined by this socket) instead of O(all rooms on the pod). */
  private readonly socketToUsers = new Map<string, Set<string>>()

  /** Returns true if first socket for this user on this instance (bump Redis inbox channel refcount). */

  join(userId: string, socketKey: string, rs: RegisteredSocket): boolean {
    let inner = this.userToSockets.get(userId)

    if (!inner) {
      inner = new Map()

      this.userToSockets.set(userId, inner)
    }

    const first = !inner.has(socketKey)

    inner.set(socketKey, rs)

    let users = this.socketToUsers.get(socketKey)
    if (!users) {
      users = new Set()
      this.socketToUsers.set(socketKey, users)
    }
    users.add(userId)

    return first
  }

  leave(userId: string, socketKey: string): boolean {
    const inner = this.userToSockets.get(userId)

    if (!inner || !inner.has(socketKey)) return false

    inner.delete(socketKey)

    if (inner.size === 0) this.userToSockets.delete(userId)

    const users = this.socketToUsers.get(socketKey)
    if (users) {
      users.delete(userId)
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

  getSockets(userId: string): RegisteredSocket[] {
    const inner = this.userToSockets.get(userId)

    if (!inner) return []

    return [...inner.values()]
  }
}

export const userInboxRooms = new UserInboxRooms()
