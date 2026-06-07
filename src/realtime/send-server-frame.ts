import type { WebSocket } from 'ws'

import type { ServerFrame } from './types'

/** Shared JSON serialization for outgoing WS frames (BigInt-safe). */

export function sendServerFrame(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== 1) return

  const payload = JSON.stringify(frame, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

  socket.send(payload)
}
