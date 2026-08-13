import type { RegisteredSocket } from './connection-registry'

export type RoomSocket = RegisteredSocket

/**
 * Sockets that JOINed a support ticket on this instance (owner verified at JOIN).
 * Channel key = ticket id as decimal string.
 */
class SupportTicketRooms {
  private readonly ticketToSockets = new Map<string, Map<string, RoomSocket>>()
  /** Reverse index: socketId -> ticket ids it has joined. Keeps leaveAllForSocket
   *  O(rooms joined by this socket) instead of O(all rooms on the pod). */
  private readonly socketToTickets = new Map<string, Set<string>>()

  join(ticketId: string, socketKey: string, rs: RoomSocket): boolean {
    let inner = this.ticketToSockets.get(ticketId)
    if (!inner) {
      inner = new Map()
      this.ticketToSockets.set(ticketId, inner)
    }
    const first = !inner.has(socketKey)
    inner.set(socketKey, rs)

    let tickets = this.socketToTickets.get(socketKey)
    if (!tickets) {
      tickets = new Set()
      this.socketToTickets.set(socketKey, tickets)
    }
    tickets.add(ticketId)

    return first
  }

  leave(ticketId: string, socketKey: string): boolean {
    const inner = this.ticketToSockets.get(ticketId)
    if (!inner || !inner.has(socketKey)) return false
    inner.delete(socketKey)
    if (inner.size === 0) this.ticketToSockets.delete(ticketId)

    const tickets = this.socketToTickets.get(socketKey)
    if (tickets) {
      tickets.delete(ticketId)
      if (tickets.size === 0) this.socketToTickets.delete(socketKey)
    }

    return true
  }

  leaveAllForSocket(socketKey: string): string[] {
    const tickets = this.socketToTickets.get(socketKey)
    if (!tickets) return []
    const emptied: string[] = []
    for (const ticketId of tickets) {
      const inner = this.ticketToSockets.get(ticketId)
      if (inner?.has(socketKey)) {
        inner.delete(socketKey)
        emptied.push(ticketId)
        if (inner.size === 0) this.ticketToSockets.delete(ticketId)
      }
    }
    this.socketToTickets.delete(socketKey)
    return emptied
  }

  getSockets(ticketId: string): RoomSocket[] {
    const inner = this.ticketToSockets.get(ticketId)
    if (!inner) return []
    return [...inner.values()]
  }

  /** Distinct userIds still joined on this instance for a ticket. */
  localViewerUserIds(ticketId: string): string[] {
    const users = new Set<string>()
    for (const rs of this.getSockets(ticketId)) users.add(rs.userId)
    return [...users]
  }
}

export const supportTicketRooms = new SupportTicketRooms()
