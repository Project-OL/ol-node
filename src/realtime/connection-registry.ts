import type { WebSocket } from 'ws'

export type RegisteredSocket = {
  socketId: string
  userId: string
  ws: WebSocket
}

/**
 * Per-process registry of WebSocket connections (multi-device: several sockets per user).
 */
class ConnectionRegistry {
  private readonly byUser = new Map<string, Map<string, RegisteredSocket>>()

  add(userId: string, socketId: string, ws: WebSocket): void {
    let inner = this.byUser.get(userId)
    if (!inner) {
      inner = new Map()
      this.byUser.set(userId, inner)
    }
    inner.set(socketId, { socketId, userId, ws })
  }

  remove(userId: string, socketId: string): void {
    const inner = this.byUser.get(userId)
    if (!inner) return
    inner.delete(socketId)
    if (inner.size === 0) this.byUser.delete(userId)
  }

  getSocketsForUser(userId: string): RegisteredSocket[] {
    const inner = this.byUser.get(userId)
    if (!inner) return []
    return [...inner.values()]
  }

  /** True if this instance holds at least one active socket for the user. */
  userIsLocal(userId: string): boolean {
    const inner = this.byUser.get(userId)
    return inner !== undefined && inner.size > 0
  }

  /** Distinct users with at least one socket on this instance. */
  localUserCount(): number {
    return this.byUser.size
  }

  /** Total socket connections on this instance (all users). */
  totalSockets(): number {
    let n = 0
    for (const m of this.byUser.values()) n += m.size
    return n
  }

  forEachRegistered(cb: (rs: RegisteredSocket) => void): void {
    for (const inner of this.byUser.values()) {
      for (const rs of inner.values()) {
        cb(rs)
      }
    }
  }
}

export const connectionRegistry = new ConnectionRegistry()
