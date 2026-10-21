import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  findById: vi.fn(),
  findDisplayRowsByIds: vi.fn(),
  findActiveByUserAndType: vi.fn(),
  findActiveByUser: vi.fn(),
  listByUser: vi.fn(),
  findByIdRestriction: vi.fn(),
  create: vi.fn(),
  clearActiveOfType: vi.fn(),
  clear: vi.fn(),
  messageReportFindUnique: vi.fn(),
  auditLog: vi.fn(),
  publishServerFrameToUser: vi.fn(),
  assertAllowed: vi.fn(),
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    get: (...a: unknown[]) => mocks.redisGet(...a),
    set: (...a: unknown[]) => mocks.redisSet(...a),
    del: (...a: unknown[]) => mocks.redisDel(...a),
  },
  RedisKeys: {
    userRestriction: (userId: string, type: string) => `user:restriction:${userId}:${type}`,
  },
}))

vi.mock('../../src/config/database', () => ({
  prismaRead: {
    messageReport: {
      findUnique: (...a: unknown[]) => mocks.messageReportFindUnique(...a),
    },
  },
}))

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...a: unknown[]) => mocks.findById(...a),
    findDisplayRowsByIds: (...a: unknown[]) => mocks.findDisplayRowsByIds(...a),
  },
}))

vi.mock('../../src/repositories/userRestriction.repository', () => ({
  userRestrictionRepository: {
    findActiveByUserAndType: (...a: unknown[]) => mocks.findActiveByUserAndType(...a),
    findActiveByUser: (...a: unknown[]) => mocks.findActiveByUser(...a),
    listByUser: (...a: unknown[]) => mocks.listByUser(...a),
    findById: (...a: unknown[]) => mocks.findByIdRestriction(...a),
    create: (...a: unknown[]) => mocks.create(...a),
    clearActiveOfType: (...a: unknown[]) => mocks.clearActiveOfType(...a),
    clear: (...a: unknown[]) => mocks.clear(...a),
  },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { logAdmin: (...a: unknown[]) => mocks.auditLog(...a) },
}))

vi.mock('../../src/utils/ws-publisher', () => ({
  publishServerFrameToUser: (...a: unknown[]) => mocks.publishServerFrameToUser(...a),
}))

// Country-scoped admin permissions have their own service; here we only check it is consulted.
vi.mock('../../src/services/adminCountryAccess.service', () => ({
  adminCountryAccessService: {
    assertAllowed: (...a: unknown[]) => mocks.assertAllowed(...a),
  },
}))

import { userRestrictionService } from '../../src/services/userRestriction.service'

const USER_A = '11111111-1111-1111-1111-111111111111'
const USER_B = '22222222-2222-2222-2222-222222222222'
const USER_C = '33333333-3333-3333-3333-333333333333'
const ADMIN = 'admin-1'
const ROLE = 'SUPER_ADMIN' as const
const FUTURE = new Date(Date.now() + 86_400_000)

function restrictionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rest-1',
    userId: USER_A,
    type: 'MESSAGING_DISABLE',
    restrictedUntil: FUTURE,
    reason: 'spam',
    reportId: null,
    createdByAdminId: ADMIN,
    clearedAt: null,
    clearedByAdminId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    targets: [],
    ...overrides,
  }
}

describe('userRestrictionService messaging targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findById.mockResolvedValue({ id: USER_A, country: 'India' })
    mocks.assertAllowed.mockResolvedValue(undefined)
    mocks.clearActiveOfType.mockResolvedValue(0)
    mocks.publishServerFrameToUser.mockResolvedValue(undefined)
    mocks.redisSet.mockResolvedValue('OK')
    mocks.redisDel.mockResolvedValue(1)
    mocks.redisGet.mockResolvedValue(null)
  })

  it('applies a targeted messaging ban and caches targetUserIds', async () => {
    mocks.findDisplayRowsByIds.mockResolvedValue([{ id: USER_B }, { id: USER_C }])
    const created = restrictionRow({
      targets: [{ targetUserId: USER_B }, { targetUserId: USER_C }],
    })
    mocks.create.mockResolvedValue(created)

    const dto = await userRestrictionService.apply({
      userId: USER_A,
      type: 'MESSAGING_DISABLE',
      restrictedUntil: FUTURE,
      adminUserId: ADMIN,
      adminRole: ROLE,
      targetUserIds: [USER_B, USER_C],
    })

    expect(dto.targetUserIds).toEqual([USER_B, USER_C])
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserIds: [USER_B, USER_C] }),
    )
    const setArgs = mocks.redisSet.mock.calls[0]
    expect(setArgs[0]).toBe(`user:restriction:${USER_A}:MESSAGING_DISABLE`)
    expect(JSON.parse(setArgs[1] as string)).toEqual({
      until: FUTURE.toISOString(),
      restrictedUntil: FUTURE.toISOString(),
      targetUserIds: [USER_B, USER_C],
    })
  })

  it('blocks only listed recipients and allows others', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({ until: FUTURE.toISOString(), targetUserIds: [USER_B] }),
    )

    await expect(
      userRestrictionService.assertMessagingAllowed(USER_A, USER_B),
    ).rejects.toMatchObject({ code: 'MESSAGING_DISABLED', statusCode: 403 })

    await expect(
      userRestrictionService.assertMessagingAllowed(USER_A, USER_C),
    ).resolves.toBeUndefined()
  })

  it('blocks every recipient for a global (no-target) messaging ban', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({ until: FUTURE.toISOString(), targetUserIds: null }),
    )

    await expect(
      userRestrictionService.assertMessagingAllowed(USER_A, USER_B),
    ).rejects.toBeInstanceOf(AppError)
    await expect(
      userRestrictionService.assertMessagingAllowed(USER_A, USER_C),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('writes Live-server compatible restrictedUntil on chat mute cache', async () => {
    mocks.create.mockResolvedValue(restrictionRow({ type: 'LIVE_CHAT_MUTE', targets: [] }))

    await userRestrictionService.apply({
      userId: USER_A,
      type: 'LIVE_CHAT_MUTE',
      restrictedUntil: FUTURE,
      adminUserId: ADMIN,
      adminRole: ROLE,
    })

    const payload = JSON.parse(mocks.redisSet.mock.calls[0][1] as string) as {
      until: string
      restrictedUntil: string
    }
    expect(payload.until).toBe(FUTURE.toISOString())
    expect(payload.restrictedUntil).toBe(FUTURE.toISOString())
    expect(mocks.redisSet.mock.calls[0][0]).toBe(`user:restriction:${USER_A}:LIVE_CHAT_MUTE`)
  })

  it('treats a legacy ISO redis value as a global send ban', async () => {
    mocks.redisGet.mockResolvedValue(FUTURE.toISOString())

    await expect(
      userRestrictionService.assertMessagingAllowed(USER_A, USER_B),
    ).rejects.toMatchObject({ code: 'MESSAGING_DISABLED' })
  })

  it('does not treat a targeted ban as a full-account messaging disable', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({ until: FUTURE.toISOString(), targetUserIds: [USER_B] }),
    )

    await expect(
      userRestrictionService.assertNotRestricted(USER_A, 'MESSAGING_DISABLE'),
    ).resolves.toBeUndefined()
  })

  it('extends an existing targeted ban by unioning peers and keeping the later expiry', async () => {
    const later = new Date(FUTURE.getTime() + 86_400_000)
    mocks.findActiveByUserAndType.mockResolvedValue(
      restrictionRow({
        restrictedUntil: later,
        targets: [{ targetUserId: USER_B }],
      }),
    )
    mocks.findDisplayRowsByIds.mockResolvedValue([{ id: USER_C }])
    mocks.create.mockImplementation(
      async (data: { targetUserIds?: string[]; restrictedUntil: Date }) =>
        restrictionRow({
          restrictedUntil: data.restrictedUntil,
          targets: (data.targetUserIds ?? []).map((targetUserId: string) => ({ targetUserId })),
        }),
    )

    const earlier = new Date(FUTURE.getTime() - 3_600_000)
    const dto = await userRestrictionService.apply({
      userId: USER_A,
      type: 'MESSAGING_DISABLE',
      restrictedUntil: earlier,
      adminUserId: ADMIN,
      adminRole: ROLE,
      targetUserIds: [USER_C],
      extend: true,
    })

    expect(dto.targetUserIds).toEqual(expect.arrayContaining([USER_B, USER_C]))
    expect(dto.targetUserIds).toHaveLength(2)
    expect(new Date(dto.restrictedUntil).getTime()).toBe(later.getTime())
  })

  it('rejects adding specific targets onto a global messaging ban via extend', async () => {
    mocks.findActiveByUserAndType.mockResolvedValue(restrictionRow({ targets: [] }))
    mocks.findDisplayRowsByIds.mockResolvedValue([{ id: USER_B }])

    await expect(
      userRestrictionService.apply({
        userId: USER_A,
        type: 'MESSAGING_DISABLE',
        restrictedUntil: FUTURE,
        adminUserId: ADMIN,
        adminRole: ROLE,
        targetUserIds: [USER_B],
        extend: true,
      }),
    ).rejects.toMatchObject({ code: 'CANNOT_NARROW_GLOBAL_MESSAGING_BAN' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('rejects targetUserIds on non-messaging restriction types', async () => {
    await expect(
      userRestrictionService.apply({
        userId: USER_A,
        type: 'LIVE_CHAT_MUTE',
        restrictedUntil: FUTURE,
        adminUserId: ADMIN,
        adminRole: ROLE,
        targetUserIds: [USER_B],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('checks the admin may act on the user’s country before writing anything', async () => {
    mocks.create.mockResolvedValue(restrictionRow({ type: 'LIVE_CHAT_MUTE', targets: [] }))
    await userRestrictionService.apply({
      userId: USER_A,
      type: 'LIVE_CHAT_MUTE',
      restrictedUntil: FUTURE,
      adminUserId: ADMIN,
      adminRole: ROLE,
    })
    expect(mocks.assertAllowed).toHaveBeenCalledWith(ADMIN, ROLE, 'India')
  })

  it('writes nothing when the admin is not allowed for the user’s country', async () => {
    mocks.assertAllowed.mockRejectedValue(
      new AppError(403, 'Not allowed for this country', 'COUNTRY_ACCESS_DENIED'),
    )
    await expect(
      userRestrictionService.apply({
        userId: USER_A,
        type: 'LIVE_CHAT_MUTE',
        restrictedUntil: FUTURE,
        adminUserId: ADMIN,
        adminRole: ROLE,
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.redisSet).not.toHaveBeenCalled()
  })

  it('rejects targeting the restricted user themselves', async () => {
    await expect(
      userRestrictionService.apply({
        userId: USER_A,
        type: 'MESSAGING_DISABLE',
        restrictedUntil: FUTURE,
        adminUserId: ADMIN,
        adminRole: ROLE,
        targetUserIds: [USER_A],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
