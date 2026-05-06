import { describe, it, expect, beforeEach } from 'vitest'
import type { WebSocket } from 'ws'
import { connectionRegistry } from '../../src/realtime/connection-registry'

function fakeWs(): WebSocket {
  return {} as WebSocket
}

function clearRegistry(): void {
  const r = connectionRegistry as unknown as {
    byUser: Map<string, Map<string, unknown>>
  }
  r.byUser.clear()
}

describe('connectionRegistry', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('add / remove / getSocketsForUser / userIsLocal / localUserCount', () => {
    const a1 = 'a1'
    const a2 = 'a2'
    const u = 'user-1'
    connectionRegistry.add(u, a1, fakeWs())
    expect(connectionRegistry.userIsLocal(u)).toBe(true)
    expect(connectionRegistry.localUserCount()).toBe(1)
    expect(connectionRegistry.getSocketsForUser(u)).toHaveLength(1)

    connectionRegistry.add(u, a2, fakeWs())
    expect(connectionRegistry.getSocketsForUser(u)).toHaveLength(2)
    expect(connectionRegistry.localUserCount()).toBe(1)

    connectionRegistry.remove(u, a1)
    expect(connectionRegistry.getSocketsForUser(u)).toHaveLength(1)
    connectionRegistry.remove(u, a2)
    expect(connectionRegistry.userIsLocal(u)).toBe(false)
    expect(connectionRegistry.localUserCount()).toBe(0)
  })

  it('totalSockets counts all connections', () => {
    connectionRegistry.add('u1', 's1', fakeWs())
    connectionRegistry.add('u1', 's2', fakeWs())
    connectionRegistry.add('u2', 's3', fakeWs())
    expect(connectionRegistry.totalSockets()).toBe(3)
    expect(connectionRegistry.localUserCount()).toBe(2)
  })

  it('forEachRegistered visits all sockets', () => {
    connectionRegistry.add('u1', 's1', fakeWs())
    connectionRegistry.add('u2', 's2', fakeWs())
    const seen: string[] = []
    connectionRegistry.forEachRegistered((rs) => seen.push(rs.userId + rs.socketId))
    expect(seen.sort()).toEqual(['u1s1', 'u2s2'])
  })
})
