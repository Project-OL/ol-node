import { describe, it, expect, vi, beforeEach } from 'vitest'

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDel = vi.fn()
const cacheExists = vi.fn()
const cacheTtl = vi.fn()

vi.mock('../../src/services/cacheRedis.service', () => ({
  cacheRedisService: {
    get: (...a: unknown[]) => cacheGet(...a),
    set: (...a: unknown[]) => cacheSet(...a),
    del: (...a: unknown[]) => cacheDel(...a),
    exists: (...a: unknown[]) => cacheExists(...a),
    ttl: (...a: unknown[]) => cacheTtl(...a),
  },
}))

const findForMe = vi.fn()
const updateProfile = vi.fn()
const getTokenVersion = vi.fn()

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findForMe: (...a: unknown[]) => findForMe(...a),
    updateProfile: (...a: unknown[]) => updateProfile(...a),
    getTokenVersion: (...a: unknown[]) => getTokenVersion(...a),
  },
}))

const putObjectBuffer = vi.fn()
const getCdnOrS3PublicUrl = vi.fn((key: string) => `https://cdn.example/${key}`)
const deleteObject = vi.fn()

vi.mock('../../src/services/storage.service', () => ({
  storageService: {
    putObjectBuffer: (...a: unknown[]) => putObjectBuffer(...a),
    getCdnOrS3PublicUrl: (...a: unknown[]) => getCdnOrS3PublicUrl(...a),
    deleteObject: (...a: unknown[]) => deleteObject(...a),
  },
}))

import { meService } from '../../src/services/me.service'
import { verifyAccess } from '../../src/utils/jwt'

function baseRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    username: 'jdoe',
    publicId: BigInt(99),
    firstName: 'Jane',
    lastName: 'Doe',
    gender: 'female',
    avatarUrl: null as string | null,
    bio: null as string | null,
    usernameUpdatedAt: null as Date | null,
    passwordSet: true,
    authIdentifiers: [
      { provider: 'email', identifier: 'j@example.com', isPrimary: true },
    ],
    ...over,
  }
}

describe('meService', () => {
  beforeEach(() => {
    cacheGet.mockReset()
    cacheSet.mockReset()
    cacheDel.mockReset()
    cacheExists.mockReset()
    cacheTtl.mockReset()
    findForMe.mockReset()
    updateProfile.mockReset()
    getTokenVersion.mockReset()
    getTokenVersion.mockResolvedValue(0)
    putObjectBuffer.mockReset()
    deleteObject.mockReset()
  })

  it('getMe returns cached payload on Redis HIT', async () => {
    const cached = {
      userId: 'user-1',
      publicId: '99',
      name: 'Jane Doe',
      email: 'j@example.com',
      avatarUrl: null,
      bio: null,
      gender: 'female' as const,
      canChangeUsername: true,
      usernameNextChangeAt: null,
    }
    cacheGet.mockResolvedValueOnce(cached)
    const out = await meService.getMe('user-1')
    expect(out.cache).toBe('HIT')
    expect(out.data).toEqual(cached)
    expect(findForMe).not.toHaveBeenCalled()
  })

  it('getMe loads DB and sets cache on MISS', async () => {
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow())
    const out = await meService.getMe('user-1')
    expect(out.cache).toBe('MISS')
    expect(out.data.userId).toBe('user-1')
    expect(out.data.publicId).toBe('99')
    expect(cacheSet).toHaveBeenCalled()
  })

  it('patchMe name update succeeds when no lock and usernameUpdatedAt null', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    cacheExists.mockResolvedValue(false)
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(
      baseRow({
        firstName: 'New',
        lastName: 'Name',
        usernameUpdatedAt: new Date(),
      }),
    )
    const out = await meService.patchMe(
      'user-1',
      { name: 'New Name' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(out.user.name).toBe('New Name')
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        firstName: 'New',
        lastName: 'Name',
      }),
    )
    const payload = verifyAccess(out.accessToken)
    expect(payload.name).toBe('New Name')
  })

  it('patchMe name throttled when Redis lock exists', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    cacheExists.mockResolvedValue(true)
    cacheTtl.mockResolvedValue(3600)
    await expect(meService.patchMe('user-1', { name: 'Other' }, null, {})).rejects.toMatchObject({
      code: 'USERNAME_CHANGE_THROTTLED',
      statusCode: 429,
    })
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('patchMe name throttled when DB says same UTC month', async () => {
    const now = new Date()
    findForMe.mockResolvedValueOnce(baseRow({ usernameUpdatedAt: now }))
    cacheExists.mockResolvedValue(false)
    await expect(meService.patchMe('user-1', { name: 'Other' }, null, {})).rejects.toMatchObject({
      code: 'USERNAME_CHANGE_THROTTLED',
    })
    expect(cacheSet).toHaveBeenCalled()
  })

  it('patchMe rejects invalid avatar magic bytes', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    await expect(
      meService.patchMe('user-1', {}, Buffer.from([0, 1, 2, 3]), {}),
    ).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    })
    expect(putObjectBuffer).not.toHaveBeenCalled()
  })

  it('patchMe invalidates and repopulates cache after update', async () => {
    findForMe.mockResolvedValueOnce(baseRow({ bio: 'old' }))
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow({ bio: 'x'.repeat(3) }))
    await meService.patchMe(
      'user-1',
      { bio: 'hey' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(cacheDel).toHaveBeenCalled()
    expect(cacheSet).toHaveBeenCalled()
  })

  it('patchMe updates date of birth when valid YYYY-MM-DD', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow())
    await meService.patchMe(
      'user-1',
      { dob: '1999-03-15' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        dateOfBirth: new Date(Date.UTC(1999, 2, 15)),
      }),
    )
  })

  it('patchMe clears date of birth when dob is empty', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow())
    await meService.patchMe(
      'user-1',
      { dob: '   ' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ dateOfBirth: null }),
    )
  })

  it('patchMe rejects invalid calendar dob', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    await expect(meService.patchMe('user-1', { dob: '2024-02-30' }, null, {})).rejects.toMatchObject(
      { statusCode: 400, code: 'INVALID_REQUEST' },
    )
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('patchMe rolls back S3 when DB update fails', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    putObjectBuffer.mockResolvedValue(undefined)
    deleteObject.mockResolvedValue(undefined)
    updateProfile.mockRejectedValueOnce(new Error('db fail'))
    const jpeg = Buffer.alloc(32, 0)
    jpeg[0] = 0xff
    jpeg[1] = 0xd8
    jpeg[2] = 0xff
    await expect(meService.patchMe('user-1', {}, jpeg, {})).rejects.toThrow('db fail')
    expect(deleteObject).toHaveBeenCalled()
  })
})
