import { describe, it, expect, vi, beforeEach } from 'vitest'

const createTicket = vi.fn()
const findTicketById = vi.fn()
const createMessage = vi.fn()
const updateTicketStatus = vi.fn()
const rateTicket = vi.fn()
const findTicketsByUser = vi.fn()
const updateReadPointer = vi.fn()
vi.mock('../../src/repositories/support.repository', () => ({
  supportRepository: {
    createTicket: (...a: unknown[]) => createTicket(...a),
    findTicketById: (...a: unknown[]) => findTicketById(...a),
    createMessage: (...a: unknown[]) => createMessage(...a),
    updateTicketStatus: (...a: unknown[]) => updateTicketStatus(...a),
    rateTicket: (...a: unknown[]) => rateTicket(...a),
    findTicketsByUser: (...a: unknown[]) => findTicketsByUser(...a),
    findAllTickets: vi.fn(),
    findMessages: vi.fn(),
    updateReadPointer: (...a: unknown[]) => updateReadPointer(...a),
  },
}))

const redisDel = vi.fn().mockResolvedValue(1)
const redisGet = vi.fn().mockResolvedValue(null)
const redisSetex = vi.fn().mockResolvedValue('OK')

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    del: (...a: unknown[]) => redisDel(...a),
    get: (...a: unknown[]) => redisGet(...a),
    setex: (...a: unknown[]) => redisSetex(...a),
  },
  RedisKeys: {
    supportTicketList: (userId: bigint | string) => `support:tickets:user:${userId}`,
    supportTicketDetail: (ticketId: bigint | string) => `support:ticket:${ticketId}`,
  },
  SUPPORT_TICKET_LIST_TTL: 60,
  SUPPORT_TICKET_DETAIL_TTL: 30,
}))

const getPresignedPutUrl = vi.fn()
const getCdnOrS3PublicUrl = vi.fn()

vi.mock('../../src/services/storage.service', () => ({
  storageService: {
    getPresignedPutUrl: (...a: unknown[]) => getPresignedPutUrl(...a),
    getCdnOrS3PublicUrl: (...a: unknown[]) => getCdnOrS3PublicUrl(...a),
  },
}))

const { supportService } = await import('../../src/services/support.service')

const userId = '11111111-1111-1111-1111-111111111111'
const ticketId = 42n

beforeEach(() => {
  vi.clearAllMocks()
  getPresignedPutUrl.mockResolvedValue('https://signed.example/put')
  getCdnOrS3PublicUrl.mockReturnValue('https://cdn.example/key')
})

describe('supportService', () => {
  it('createTicket — valid input: creates ticket, auto-reply, OPEN, deletes list cache', async () => {
    createTicket.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'AWAITING_REPLY',
    })
    createMessage.mockResolvedValue({ id: 1n })
    updateTicketStatus.mockResolvedValue({ id: ticketId, status: 'OPEN', userId })

    const out = await supportService.createTicket(userId, {
      type: 'CONSULT',
      subType: 'TOP_UP',
      description: 'Need help',
    })

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        type: 'CONSULT',
        subType: 'TOP_UP',
        description: 'Need help',
      }),
    )
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId,
        senderType: 'SUPPORT',
        isAutoReply: true,
      }),
    )
    expect(updateTicketStatus).toHaveBeenCalledWith(ticketId, 'OPEN')
    expect(redisDel).toHaveBeenCalled()
    expect(out.status).toBe('OPEN')
  })

  it('createTicket — invalid subType throws AppError 400 INVALID_SUBTYPE', async () => {
    await expect(
      supportService.createTicket(userId, {
        type: 'CONSULT',
        subType: 'NOT_A_REAL_SUBTYPE',
        description: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SUBTYPE' })
    expect(createTicket).not.toHaveBeenCalled()
  })

  it('sendMessage — user on own OPEN ticket → AWAITING_REPLY + cache invalidation', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'OPEN',
    })
    createMessage.mockResolvedValue({ id: 2n })
    updateReadPointer.mockResolvedValue({ id: ticketId })

    await supportService.sendMessage(ticketId, userId, false, { content: 'Hello' })

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId,
        senderUserId: userId,
        senderType: 'USER',
        content: 'Hello',
      }),
    )
    expect(updateTicketStatus).toHaveBeenCalledWith(ticketId, 'AWAITING_REPLY')
    expect(updateReadPointer).toHaveBeenCalledWith(ticketId, 'USER', 2n)
    expect(redisDel).toHaveBeenCalled()
  })

  it('sendMessage — CS on AWAITING_REPLY → OPEN + cache invalidation', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId: 'other-user-id-here-0000-0000-0000-000000000002',
      status: 'AWAITING_REPLY',
    })
    createMessage.mockResolvedValue({ id: 3n })
    updateReadPointer.mockResolvedValue({ id: ticketId })

    await supportService.sendMessage(ticketId, userId, true, { content: 'We can help' })

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderType: 'SUPPORT', content: 'We can help' }),
    )
    expect(updateTicketStatus).toHaveBeenCalledWith(ticketId, 'OPEN')
    expect(updateReadPointer).toHaveBeenCalledWith(ticketId, 'SUPPORT', 3n)
    expect(redisDel).toHaveBeenCalled()
  })

  it('sendMessage — CLOSED throws 409 TICKET_CLOSED', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'CLOSED',
    })
    await expect(
      supportService.sendMessage(ticketId, userId, false, { content: 'nope' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TICKET_CLOSED' })
  })

  it('sendMessage — wrong user throws 403 TICKET_ACCESS_DENIED', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status: 'OPEN',
    })
    await expect(
      supportService.sendMessage(ticketId, userId, false, { content: 'hack' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'TICKET_ACCESS_DENIED' })
  })

  it('closeTicket — happy path sets CLOSED + metadata', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'OPEN',
    })
    updateTicketStatus.mockResolvedValue({
      id: ticketId,
      status: 'CLOSED',
      closedByUserId: userId,
    })

    await supportService.closeTicket(ticketId, userId)

    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'CLOSED',
      expect.objectContaining({ closedByUserId: userId, closedAt: expect.any(Date) }),
    )
    expect(redisDel).toHaveBeenCalled()
  })

  it('closeTicket — already CLOSED throws 409', async () => {
    findTicketById.mockResolvedValue({ id: ticketId, userId, status: 'CLOSED' })
    await expect(supportService.closeTicket(ticketId, userId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'TICKET_ALREADY_CLOSED',
    })
  })

  it('rateTicket — valid after CLOSED', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'CLOSED',
      rating: null,
    })
    rateTicket.mockResolvedValue({ id: ticketId, rating: 5 })

    await supportService.rateTicket(ticketId, userId, { rating: 5 })

    expect(rateTicket).toHaveBeenCalledWith(ticketId, 5)
    expect(redisDel).toHaveBeenCalled()
  })

  it('rateTicket — not CLOSED throws TICKET_NOT_CLOSED', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'OPEN',
      rating: null,
    })
    await expect(supportService.rateTicket(ticketId, userId, { rating: 4 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'TICKET_NOT_CLOSED',
    })
  })

  it('rateTicket — already rated', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'CLOSED',
      rating: 4,
    })
    await expect(supportService.rateTicket(ticketId, userId, { rating: 5 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'TICKET_ALREADY_RATED',
    })
  })

  it('rateTicket — wrong user', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      status: 'CLOSED',
      rating: null,
    })
    await expect(supportService.rateTicket(ticketId, userId, { rating: 3 })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TICKET_ACCESS_DENIED',
    })
  })

  it('getUploadUrl — folder=ticket uses support/tickets/{userId}/ prefix', async () => {
    await supportService.getUploadUrl(userId, false, {
      folder: 'ticket',
      fileName: 'pic.jpg',
      mimeType: 'image/jpeg',
    })

    expect(getPresignedPutUrl).toHaveBeenCalled()
    const keyArg = getPresignedPutUrl.mock.calls[0]![0] as string
    expect(keyArg.startsWith(`support/tickets/${userId}/`)).toBe(true)
  })

  it('getUploadUrl — message without ticketId throws TICKET_ID_REQUIRED', async () => {
    await expect(
      supportService.getUploadUrl(userId, false, {
        folder: 'message',
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'TICKET_ID_REQUIRED' })
  })

  it('getUploadUrl — message on CLOSED ticket throws TICKET_CLOSED', async () => {
    findTicketById.mockResolvedValue({
      id: ticketId,
      userId,
      status: 'CLOSED',
    })
    await expect(
      supportService.getUploadUrl(userId, false, {
        folder: 'message',
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        ticketId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TICKET_CLOSED' })
  })

  it('listMyTickets — serializes BigInt ids safely for cache/response', async () => {
    findTicketsByUser.mockResolvedValue({
      tickets: [
        {
          id: 99n,
          userId,
          status: 'OPEN',
          messages: [{ content: 'hi', senderType: 'USER', createdAt: new Date(), isAutoReply: false }],
        },
      ],
      total: 1,
    })

    const out = await supportService.listMyTickets(userId, { page: 1, limit: 20 })

    expect(out).toMatchObject({
      tickets: [{ id: '99' }],
      pagination: { total: 1 },
    })
    expect(redisSetex).toHaveBeenCalledOnce()
  })

  it('listMyTickets — hasUnreadMessages true when latest sender is SUPPORT and pointer behind', async () => {
    findTicketsByUser.mockResolvedValue({
      tickets: [
        {
          id: 100n,
          userId,
          userLastReadMessageId: 4n,
          csLastReadMessageId: 10n,
          messages: [
            {
              id: 5n,
              content: 'Support response',
              senderType: 'SUPPORT',
              createdAt: new Date(),
              isAutoReply: false,
            },
          ],
        },
      ],
      total: 1,
    })

    const out = await supportService.listMyTickets(userId, { page: 1, limit: 20 })
    expect(out).toMatchObject({ tickets: [{ hasUnreadMessages: true }] })
  })
})
