import type { RegisteredSocket } from './connection-registry'

/**

 * Sockets that subscribed to another user's presence via JOIN_PRESENCE (Redis `presence:user:{id}` refcount).

 */

class PresenceRooms {
  private readonly userToSockets = new Map<string, Map<string, RegisteredSocket>>()

  /** Returns true if this socket was not yet subscribed (bump Redis channel refcount). */

  join(targetUserId: string, socketKey: string, rs: RegisteredSocket): boolean {
    let inner = this.userToSockets.get(targetUserId)

    if (!inner) {
      inner = new Map()

      this.userToSockets.set(targetUserId, inner)
    }

    const first = !inner.has(socketKey)

    inner.set(socketKey, rs)

    return first
  }

  leave(targetUserId: string, socketKey: string): boolean {
    const inner = this.userToSockets.get(targetUserId)

    if (!inner || !inner.has(socketKey)) return false

    inner.delete(socketKey)

    if (inner.size === 0) this.userToSockets.delete(targetUserId)

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

  getSockets(targetUserId: string): RegisteredSocket[] {
    const inner = this.userToSockets.get(targetUserId)

    if (!inner) return []

    return [...inner.values()]
  }
}

export const presenceRooms = new PresenceRooms()
