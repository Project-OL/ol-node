import type { RegisteredSocket } from './connection-registry'

/**

 * Sockets subscribed to **`msg:user:{userId}`** for MESSAGE_DIGEST (Phase 7).

 */

class UserInboxRooms {
  private readonly userToSockets = new Map<string, Map<string, RegisteredSocket>>()

  /** Returns true if first socket for this user on this instance (bump Redis inbox channel refcount). */

  join(userId: string, socketKey: string, rs: RegisteredSocket): boolean {
    let inner = this.userToSockets.get(userId)

    if (!inner) {
      inner = new Map()

      this.userToSockets.set(userId, inner)
    }

    const first = !inner.has(socketKey)

    inner.set(socketKey, rs)

    return first
  }

  leave(userId: string, socketKey: string): boolean {
    const inner = this.userToSockets.get(userId)

    if (!inner || !inner.has(socketKey)) return false

    inner.delete(socketKey)

    if (inner.size === 0) this.userToSockets.delete(userId)

    return true
  }

  leaveAllForSocket(socketKey: string): string[] {
    const emptied: string[] = []

    for (const [userId, inner] of this.userToSockets) {
      if (inner.has(socketKey)) {
        inner.delete(socketKey)

        emptied.push(userId)

        if (inner.size === 0) this.userToSockets.delete(userId)
      }
    }

    return emptied
  }

  getSockets(userId: string): RegisteredSocket[] {
    const inner = this.userToSockets.get(userId)

    if (!inner) return []

    return [...inner.values()]
  }
}

export const userInboxRooms = new UserInboxRooms()
