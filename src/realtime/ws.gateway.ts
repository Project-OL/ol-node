import crypto from 'crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { WebSocket } from 'ws'

import { env } from '../config/env'

import { conversationRepository } from '../repositories/conversation.repository'

import { messagingService } from '../services/messaging.service'

import { presenceService } from '../services/presence.service'

import { guardianService } from '../services/guardian.service'

import {
  consumeWsTicket,
  isAdminPrincipal,
  adminIdFromPrincipal,
} from '../services/ws-ticket.service'

import { connectionRegistry, type RegisteredSocket } from './connection-registry'

import { conversationRooms } from './conversation-rooms'

import { presenceRooms } from './presence-rooms'

import { guardianRooms } from './guardian-rooms'

import { supportTicketRooms } from './support-ticket-rooms'

import { redisConversationSubscriber } from './redis-subscriber'

import { sendServerFrame } from './send-server-frame'

import { incomingBytesLength, WsFrameRateLimiter } from './ws-frame-guard'

import { userInboxRooms } from './user-inbox-rooms'

import { RedisKeys } from '../config/redis'

import { clientFrameSchema } from './frames.schemas'

import { supportRepository } from '../repositories/support.repository'

import {
  markSupportTicketWatching,
  unmarkSupportTicketWatching,
} from '../services/supportRealtime.service'

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
  const targets = [...new Set(targetUserIds)]
    .filter((id) => id && id !== userId)
    .slice(0, env.WS_MAX_PRESENCE_JOINS_PER_SOCKET)

  for (const targetUserId of targets) {
    const bump = presenceRooms.join(targetUserId, socketId, rs)

    if (bump) {
      await redisConversationSubscriber.subscribe(RedisKeys.presenceChannel(targetUserId))
    }
  }

  // Immediate snapshot so clients are not stuck offline until a presence transition.
  if (targets.length > 0) {
    const map = await presenceService.getPublicPresenceForUsers(userId, targets)
    for (const targetUserId of targets) {
      const p = map.get(targetUserId)
      sendServerFrame(socket, {
        t: 'PRESENCE',
        userId: targetUserId,
        online: p?.isOnline ?? false,
      })
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
  const targets = [...new Set(targetUserIds)].slice(0, env.WS_MAX_PRESENCE_JOINS_PER_SOCKET)

  for (const targetUserId of targets) {
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

async function handleJoinSupportTicket(
  app: FastifyInstance,
  socket: WebSocket,
  principal: string,
  socketId: string,
  ticketIdRaw: string,
): Promise<void> {
  let ticketId: bigint
  try {
    ticketId = BigInt(ticketIdRaw)
  } catch {
    sendServerFrame(socket, {
      t: 'ERROR',
      code: 'INVALID_TICKET_ID',
      message: 'ticketId must be a decimal bigint string',
    })
    return
  }

  const ticket = await supportRepository.findTicketById(ticketId)
  if (!ticket) {
    sendServerFrame(socket, {
      t: 'ERROR',
      code: 'SUPPORT_TICKET_FORBIDDEN',
      message: 'Not allowed to join this support ticket',
    })
    return
  }

  const isAdmin = isAdminPrincipal(principal)
  if (!isAdmin && ticket.userId !== principal) {
    app.log.warn({ principal, ticketId: ticketIdRaw }, '[ws] JOIN_SUPPORT_TICKET rejected')
    sendServerFrame(socket, {
      t: 'ERROR',
      code: 'SUPPORT_TICKET_FORBIDDEN',
      message: 'Not allowed to join this support ticket',
    })
    return
  }

  const ticketKey = ticketId.toString()
  const rs: RegisteredSocket = { socketId, userId: principal, ws: socket }
  const firstForSocket = supportTicketRooms.join(ticketKey, socketId, rs)
  if (firstForSocket) {
    await redisConversationSubscriber.subscribe(RedisKeys.supportTicketChannel(ticketKey))
  }
  // Only track the user-side watch counter (used to suppress FCM push); admins don't need it.
  if (!isAdmin) {
    await markSupportTicketWatching(ticketKey, principal)
  }
  app.log.info({ principal, socketId, ticketId: ticketKey, msg: 'ws join_support_ticket' }, 'realtime')
}

async function handleLeaveSupportTicket(
  userId: string,
  socketId: string,
  ticketIdRaw: string,
): Promise<void> {
  const ticketKey = ticketIdRaw
  if (!supportTicketRooms.leave(ticketKey, socketId)) return
  await redisConversationSubscriber.unsubscribe(RedisKeys.supportTicketChannel(ticketKey))
  await unmarkSupportTicketWatching(ticketKey, userId)
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
      const principal = await consumeWsTicket((request.query as { ticket?: string }).ticket)

      if (!principal) {
        socket.close(WS_UNAUTHORIZED, 'Unauthorized ticket')

        return
      }

      const isAdmin = isAdminPrincipal(principal)
      const userId = isAdmin ? adminIdFromPrincipal(principal) : principal

      const socketId = crypto.randomUUID()

      connectionRegistry.add(principal, socketId, socket)

      const rs: RegisteredSocket = { socketId, userId: principal, ws: socket }

      if (!isAdmin) {
        void presenceService.recordSocketConnected(userId)
        if (userInboxRooms.join(principal, socketId, rs)) {
          await redisConversationSubscriber.subscribe(RedisKeys.userInboxChannel(principal))
        }
      }

      app.log.info({ principal, userId, isAdmin, socketId, msg: 'ws connect' }, 'realtime')

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

        const supportTicketIds = supportTicketRooms.leaveAllForSocket(socketId)
        for (const tid of supportTicketIds) {
          void redisConversationSubscriber.unsubscribe(RedisKeys.supportTicketChannel(tid))
          if (!isAdmin) void unmarkSupportTicketWatching(tid, principal)
        }

        if (!isAdmin) {
          const inboxIds = userInboxRooms.leaveAllForSocket(socketId)
          for (const uid of inboxIds) {
            void redisConversationSubscriber.unsubscribe(RedisKeys.userInboxChannel(uid))
          }
          void presenceService.recordSocketDisconnected(userId)
        }

        connectionRegistry.remove(principal, socketId)

        app.log.info({ principal, userId, isAdmin, socketId, msg: 'ws close' }, 'realtime')
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

      let inboundChain = Promise.resolve()
      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        inboundChain = inboundChain
          .then(async () => {
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
              if (!isAdmin) {
                app.log.info({ userId, socketId, conversationId: frame.conversationId, msg: 'ws join' }, 'realtime')
                await handleJoin(app, socket, userId, socketId, frame.conversationId)
              }
            } else if (frame.t === 'LEAVE') {
              if (!isAdmin) {
                app.log.info({ userId, socketId, conversationId: frame.conversationId, msg: 'ws leave' }, 'realtime')
                await handleLeave(socketId, frame.conversationId)
              }
            } else if (frame.t === 'PING') {
              if (!isAdmin) void presenceService.refreshOnlineHeartbeat(userId)
              sendServerFrame(socket, { t: 'PONG', ts: frame.ts })
            } else if (frame.t === 'TYPING') {
              if (!isAdmin) await messagingService.handleTypingFrame(userId, frame.conversationId, frame.isTyping)
            } else if (frame.t === 'RECORDING') {
              if (!isAdmin) await messagingService.handleRecordingFrame(userId, frame.conversationId, frame.isRecording)
            } else if (frame.t === 'READ') {
              if (!isAdmin) messagingService.scheduleReadReceipt(userId, frame.conversationId, frame.lastReadMessageId)
            } else if (frame.t === 'JOIN_PRESENCE') {
              if (!isAdmin) await handleJoinPresence(socket, socketId, userId, frame.userIds)
            } else if (frame.t === 'LEAVE_PRESENCE') {
              if (!isAdmin) await handleLeavePresence(socketId, frame.userIds)
            } else if (frame.t === 'JOIN_GUARDIAN') {
              if (!isAdmin) await handleJoinGuardian(socket, socketId, userId, frame.userIds)
            } else if (frame.t === 'LEAVE_GUARDIAN') {
              if (!isAdmin) await handleLeaveGuardian(socketId, frame.userIds)
            } else if (frame.t === 'JOIN_SUPPORT_TICKET') {
              await handleJoinSupportTicket(app, socket, principal, socketId, frame.ticketId)
            } else if (frame.t === 'LEAVE_SUPPORT_TICKET') {
              await handleLeaveSupportTicket(principal, socketId, frame.ticketId)
            } else if (frame.t === 'RESUME') {
              if (!isAdmin) {
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
            }
          } catch (e) {
            app.log.warn({ e, userId, isAdmin, socketId }, '[ws] message handler error')
          }
        })
        .catch((e) => {
          app.log.warn({ e, userId, isAdmin, socketId }, '[ws] inbound chain error')
        })
      })
    },
  )
}
