import { describe, it, expect, vi, beforeEach } from 'vitest'

const putObjectBuffer = vi.fn()
const mkdir = vi.fn()
const writeFile = vi.fn()
const env: { ACCOUNT_ARCHIVE_S3_BUCKET?: string } = {}

vi.mock('../../src/config/env', () => ({ env }))
vi.mock('../../src/config/database', () => ({ prisma: {}, prismaRead: {} }))
vi.mock('../../src/services/storage.service', () => ({ storageService: { putObjectBuffer } }))
vi.mock('fs/promises', () => ({ default: { mkdir, writeFile } }))

const { writeAccountArchive } = await import('../../src/repositories/user.repository')

describe('INF-03 account-deletion archive target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete env.ACCOUNT_ARCHIVE_S3_BUCKET
  })

  it('unset: writes to local disk exactly as before', async () => {
    const where = await writeAccountArchive('u1-1.json', '{"a":1}')
    expect(where.split(String.fromCharCode(92)).join('/')).toMatch(/data.account-archives.u1-1.json$/)
    expect(writeFile).toHaveBeenCalledWith(where, '{"a":1}', 'utf8')
    expect(putObjectBuffer).not.toHaveBeenCalled()
  })

  it('set: writes to the private bucket, never to disk', async () => {
    env.ACCOUNT_ARCHIVE_S3_BUCKET = ' offoo-account-archives '
    const where = await writeAccountArchive('u1-1.json', '{"a":1}')
    expect(where).toBe('s3://offoo-account-archives/account-archives/u1-1.json')
    expect(putObjectBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'offoo-account-archives',
        key: 'account-archives/u1-1.json',
        contentType: 'application/json',
        cacheControl: 'no-store',
      }),
    )
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('a bucket failure propagates so the caller records archiveLocation none', async () => {
    env.ACCOUNT_ARCHIVE_S3_BUCKET = 'b'
    putObjectBuffer.mockRejectedValueOnce(new Error('denied'))
    await expect(writeAccountArchive('x.json', '{}')).rejects.toThrow('denied')
  })
})
