import { describe, it, expect, beforeEach } from 'vitest'
import type { WebSocket } from 'ws'
import { conversationRooms } from '../../src/realtime/conversation-rooms'
import type { RegisteredSocket } from '../../src/realtime/connection-registry'

function rs(userId: string, socketId: string): RegisteredSocket {
  return { userId, socketId, ws: {} as WebSocket }
}

describe('conversationRooms', () => {
  beforeEach(() => {
    const empty = conversationRooms as unknown as {
      convToSockets: Map<string, Map<string, RegisteredSocket>>
    }
    empty.convToSockets.clear()
  })

  it('join returns true only on first join per socket in a conversation', () => {
    const j1 = conversationRooms.join('c1', 'sock1', rs('u1', 'sock1'))
    const j2 = conversationRooms.join('c1', 'sock1', rs('u1', 'sock1'))
    expect(j1).toBe(true)
    expect(j2).toBe(false)
  })

  it('leave returns false when socket was not in room', () => {
    expect(conversationRooms.leave('c1', 'sock1')).toBe(false)
  })

  it('leave returns true and empties room', () => {
    conversationRooms.join('c1', 'sock1', rs('u1', 'sock1'))
    expect(conversationRooms.leave('c1', 'sock1')).toBe(true)
    expect(conversationRooms.getSockets('c1')).toHaveLength(0)
  })

  it('leaveAllForSocket removes from every conversation', () => {
    conversationRooms.join('c1', 'sock1', rs('u1', 'sock1'))
    conversationRooms.join('c2', 'sock1', rs('u1', 'sock1'))
    const ids = conversationRooms.leaveAllForSocket('sock1')
    expect(ids.sort()).toEqual(['c1', 'c2'])
    expect(conversationRooms.getSockets('c1')).toHaveLength(0)
    expect(conversationRooms.getSockets('c2')).toHaveLength(0)
  })

  it('joinedConversationCount counts distinct convs for a socket', () => {
    conversationRooms.join('c1', 'sock1', rs('u1', 'sock1'))
    conversationRooms.join('c2', 'sock1', rs('u1', 'sock1'))
    expect(conversationRooms.joinedConversationCount('sock1')).toBe(2)
  })
})
