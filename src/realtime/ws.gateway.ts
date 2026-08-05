import crypto from 'crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { WebSocket } from 'ws'

import { env } from '../config/env'

import { conversationRepository } from '../repositories/conversation.repository'

import { messagingService } from '../services/messaging.service'

import { presenceService } from '../services/presence.service'

import { guardianService } from '../services/guardian.service'

import { consumeWsTicket } from '../services/ws-ticket.service'

import { connectionRegistry, type RegisteredSocket } from './connection-registry'

import { conversationRooms } from './conversation-rooms'

import { presenceRooms } from './presence-rooms'

import { guardianRooms } from './guardian-rooms'

import { redisConversationSubscriber } from './redis-subscriber'

import { sendServerFrame } from './send-server-frame'

import { incomingBytesLength, WsFrameRateLimiter } from './ws-frame-guard'

import { userInboxRooms } from './user-inbox-rooms'

import { RedisKeys } from '../config/redis'

import { clientFrameSchema } from './frames.schemas'

/** Invalid ticket — same as Phase 1. */

const WS_UNAUTHORIZED = 4401

/** Too many frames per second (Phase 4). */

const WS_RATE_LIMITED = 4402

/** Idle timeout — no inbound frames within WS_IDLE_TIMEOUT_MS (Phase 4). */

const WS_IDLE_TIMEOUT_CODE = 4403

/** RFC 1009 — message too big. */

const WS_TOO_LARGE = 1009

const wsFrameLimiter = new WsFrameRateLimiter(env.WS_MAX_CLIENT_FRAMES_PER_SEC)

async function handleJoin(
  app: FastifyInstance,

  socket: WebSocket,

  userId: string,

  socketId: string,

  conversationId: string,
): Promise<void> {
  if (conversationRooms.joinedConversationCount(socketId) >= env.WS_MAX_CONV_JOINS_PER_SOCKET) {
    app.log.warn({ userId, socketId, conversationId }, '[ws] JOIN rejected — room limit')

    return
  }

  const conv = await conversationRepository.findConversationById(conversationId, userId)

  if (!conv) {
    app.log.warn({ userId, conversationId }, '[ws] JOIN rejected — not a member')

    return
  }

  await messagingService.touchConvMemberCache(userId, conv.id)

  const rs: RegisteredSocket = { socketId, userId, ws: socket }

  const shouldBumpChannel = conversationRooms.join(conv.id, socketId, rs)

  if (shouldBumpChannel) {
    await redisConversationSubscriber.subscribe(RedisKeys.convChannel(conv.id))
  }
}

async function handleLeave(socketId: string, conversationId: string): Promise<void> {
  if (!conversationRooms.leave(conversationId, socketId)) return

  await redisConversationSubscriber.unsubscribe(RedisKeys.convChannel(conversationId))
}

async function handleJoinPresence(
  socket: WebSocket,

  socketId: string,

  userId: string,

  targetUserIds: string[],
): Promise<void> {
  const rs: RegisteredSocket = { socketId, userId, ws: socket }

  for (const targetUserId of new Set(targetUserIds)) {
    if (targetUserId === userId) continue

    const bump = presenceRooms.join(targetUserId, socketId, rs)

    if (bump) {
      await redisConversationSubscriber.subscribe(RedisKeys.presenceChannel(targetUserId))
    }
  }
}

async function handleLeavePresence(socketId: string, targetUserIds: string[]): Promise<void> {
  for (const targetUserId of new Set(targetUserIds)) {
    if (!presenceRooms.leave(targetUserId, socketId)) continue

    await redisConversationSubscriber.unsubscribe(RedisKeys.presenceChannel(targetUserId))
  }
}

async function handleJoinGuardian(
  socket: WebSocket,
  socketId: string,
  viewerUserId: string,
  targetUserIds: string[],
): Promise<void> {
  const rs: RegisteredSocket = { socketId, userId: viewerUserId, ws: socket }

  for (const targetUserId of new Set(targetUserIds)) {
    const bump = guardianRooms.join(targetUserId, socketId, rs)
    if (bump) {
      await redisConversationSubscriber.subscribe(RedisKeys.guardianWatchChannel(targetUserId))
    }
    try {
      const snapshot = await guardianService.buildGuardianSnapshotFrame(targetUserId)
      sendServerFrame(socket, snapshot)
    } catch {
      sendServerFrame(socket, {
        t: 'GUARDIAN',
        event: 'guardian.snapshot',
        targetUserId,
        currentGuardian: null,
      })
    }
  }
}

async function handleLeaveGuardian(socketId: string, targetUserIds: string[]): Promise<void> {
  for (const targetUserId of new Set(targetUserIds)) {
    if (!guardianRooms.leave(targetUserId, socketId)) continue
    await redisConversationSubscriber.unsubscribe(RedisKeys.guardianWatchChannel(targetUserId))
  }
}

export function registerRealtimeGateway(app: FastifyInstance): void {
  app.addHook('onReady', async () => {
    await redisConversationSubscriber.ensureStarted()
  })

  app.addHook('onClose', async () => {
    connectionRegistry.forEachRegistered((rs) => {
      sendServerFrame(rs.ws, { t: 'GOAWAY', reason: 'server_shutdown' })

      try {
        rs.ws.close(1001, 'server_shutdown')
      } catch {
        /* ignore */
      }
    })

    await redisConversationSubscriber.stop()
  })

  app.get(
    '/ws',

    {
      websocket: true,
    },

    async (socket: WebSocket, request: FastifyRequest) => {
      const userId = await consumeWsTicket((request.query as { ticket?: string }).ticket)

      if (!userId) {
        socket.close(WS_UNAUTHORIZED, 'Unauthorized ticket')

        return
      }

      const socketId = crypto.randomUUID()

      connectionRegistry.add(userId, socketId, socket)

      const rs: RegisteredSocket = { socketId, userId, ws: socket }

      void presenceService.recordSocketConnected(userId)

      if (userInboxRooms.join(userId, socketId, rs)) {
        await redisConversationSubscriber.subscribe(RedisKeys.userInboxChannel(userId))
      }

      app.log.info({ userId, socketId, msg: 'ws connect' }, 'realtime')

      let idleTimer: ReturnType<typeof setTimeout> | undefined

      const bumpIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)

        idleTimer = setTimeout(() => {
          socket.close(WS_IDLE_TIMEOUT_CODE, 'idle_timeout')
        }, env.WS_IDLE_TIMEOUT_MS)
      }

      bumpIdle()

      const drainJoinedChannels = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer)

          idleTimer = undefined
        }

        wsFrameLimiter.clear(socketId)

        const convIds = conversationRooms.leaveAllForSocket(socketId)

        for (const c of convIds) {
          void redisConversationSubscriber.unsubscribe(RedisKeys.convChannel(c))
        }

        const presenceIds = presenceRooms.leaveAllForSocket(socketId)

        for (const u of presenceIds) {
          void redisConversationSubscriber.unsubscribe(RedisKeys.presenceChannel(u))
        }

        const guardianIds = guardianRooms.leaveAllForSocket(socketId)

        for (const u of guardianIds) {
          void redisConversationSubscriber.unsubscribe(RedisKeys.guardianWatchChannel(u))
        }

        const inboxIds = userInboxRooms.leaveAllForSocket(socketId)

        for (const uid of inboxIds) {
          void redisConversationSubscriber.unsubscribe(RedisKeys.userInboxChannel(uid))
        }

        void presenceService.recordSocketDisconnected(userId)

        connectionRegistry.remove(userId, socketId)

        app.log.info({ userId, socketId, msg: 'ws close' }, 'realtime')
      }

      socket.on('close', (code: number, reason: Buffer) => {
        app.log.info(
          { userId, socketId, code, reason: reason.toString(), msg: 'ws socket close' },

          'realtime',
        )

        drainJoinedChannels()
      })

      socket.on('error', (err: Error) => {
        app.log.warn({ err, userId, socketId, msg: 'ws error' }, 'realtime')
      })

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        void (async () => {
          try {
            const byteLen = incomingBytesLength(raw)

            if (byteLen > env.WS_MAX_INCOMING_BYTES) {
              socket.close(WS_TOO_LARGE, 'frame_too_large')

              return
            }

            if (!wsFrameLimiter.allow(socketId)) {
              socket.close(WS_RATE_LIMITED, 'rate_limited')

              return
            }

            bumpIdle()

            const text = raw.toString()

            const data: unknown = JSON.parse(text)

            const parsed = clientFrameSchema.safeParse(data)

            if (!parsed.success) {
              app.log.warn(
                { userId, socketId, err: parsed.error.flatten(), data },
                '[ws] invalid client frame',
              )
              sendServerFrame(socket, {
                t: 'ERROR',
                code: 'INVALID_FRAME',
                message:
                  'Invalid WebSocket frame. JOIN_GUARDIAN requires { t, userIds: string[] } with user UUIDs (not publicId).',
                details: parsed.error.flatten(),
              })
              return
            }

            const frame = parsed.data

            if (frame.t === 'JOIN') {
              app.log.info(
                { userId, socketId, conversationId: frame.conversationId, msg: 'ws join' },
                'realtime',
              )

              await handleJoin(app, socket, userId, socketId, frame.conversationId)
            } else if (frame.t === 'LEAVE') {
              app.log.info(
                { userId, socketId, conversationId: frame.conversationId, msg: 'ws leave' },
                'realtime',
              )

              await handleLeave(socketId, frame.conversationId)
            } else if (frame.t === 'PING') {
              void presenceService.refreshOnlineHeartbeat(userId)

              sendServerFrame(socket, { t: 'PONG', ts: frame.ts })
            } else if (frame.t === 'TYPING') {
              await messagingService.handleTypingFrame(
                userId,
                frame.conversationId,
                frame.isTyping,
              )
            } else if (frame.t === 'RECORDING') {
              await messagingService.handleRecordingFrame(
                userId,
                frame.conversationId,
                frame.isRecording,
              )
            } else if (frame.t === 'READ') {
              messagingService.scheduleReadReceipt(
                userId,
                frame.conversationId,
                frame.lastReadMessageId,
              )
            } else if (frame.t === 'JOIN_PRESENCE') {
              await handleJoinPresence(socket, socketId, userId, frame.userIds)
            } else if (frame.t === 'LEAVE_PRESENCE') {
              await handleLeavePresence(socketId, frame.userIds)
            } else if (frame.t === 'JOIN_GUARDIAN') {
              app.log.info(
                { userId, socketId, targetUserIds: frame.userIds, msg: 'ws join_guardian' },
                'realtime',
              )
              await handleJoinGuardian(socket, socketId, userId, frame.userIds)
            } else if (frame.t === 'LEAVE_GUARDIAN') {
              app.log.info(
                { userId, socketId, targetUserIds: frame.userIds, msg: 'ws leave_guardian' },
                'realtime',
              )
              await handleLeaveGuardian(socketId, frame.userIds)
            } else if (frame.t === 'RESUME') {
              const rows = await messagingService.getResumeSyncStates(userId, frame.conversations)

              for (const r of rows) {
                sendServerFrame(socket, {
                  t: 'SYNC_STATE',
                  conversationId: r.conversationId,
                  latestSeq: r.latestSeq,
                  hasGap: r.hasGap,
                })
              }
            }
          } catch (e) {
            app.log.warn({ e, userId, socketId }, '[ws] message handler error')
          }
        })()
      })
    },
  )
}
