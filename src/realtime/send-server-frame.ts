import type { WebSocket } from 'ws'

import { env } from '../config/env'
import type { ServerFrame } from './types'

export function isSocketWritable(socket: WebSocket): boolean {
  if (socket.readyState !== 1) return false
  const buffered = (socket as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0
  return buffered <= env.WS_SEND_BUFFER_LIMIT_BYTES
}

/** Shared JSON serialization for outgoing WS frames (BigInt-safe). */
export function sendServerFrame(socket: WebSocket, frame: ServerFrame): void {
  if (!isSocketWritable(socket)) return

  const payload = JSON.stringify(frame, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

  socket.send(payload)
}
