import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const getObjectBuffer = vi.fn()
const putObjectBuffer = vi.fn()

vi.mock('../services/storage.service', () => ({
  storageService: {
    getObjectBuffer: (...a: unknown[]) => getObjectBuffer(...a),
    putObjectBuffer: (...a: unknown[]) => putObjectBuffer(...a),
    getCdnOrS3PublicUrl: (key: string) => `https://cdn.example.com/${key}`,
  },
}))

vi.mock('../utils/rootLogger', () => ({
  rootLogger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}))

import { avatarResizeService, AVATAR_MAX_PX, RESIZED_AVATAR_SUFFIX } from './avatar-resize.service'

const userId = '11111111-2222-3333-4444-555555555555'

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg({ quality: 95 })
    .toBuffer()
}

describe('avatarResizeService.shrinkBuffer', () => {
  it('caps a large photo at 512px and re-encodes as WebP', async () => {
    const out = await avatarResizeService.shrinkBuffer(await jpeg(1000, 800))
    expect(out).not.toBeNull()
    expect(out!.contentType).toBe('image/webp')
    expect(out!.ext).toBe('webp')
    const meta = await sharp(out!.buffer).metadata()
    expect(meta.format).toBe('webp')
    expect(Math.max(meta.width!, meta.height!)).toBe(AVATAR_MAX_PX)
  })

  it('returns null (keep original) for an image already inside 512px', async () => {
    expect(await avatarResizeService.shrinkBuffer(await jpeg(300, 300))).toBeNull()
  })

  it('returns null for bytes that are not an image', async () => {
    expect(await avatarResizeService.shrinkBuffer(Buffer.from('not an image'))).toBeNull()
  })
})

describe('avatarResizeService.shrinkOwnedAvatarUrl', () => {
  beforeEach(() => {
    getObjectBuffer.mockReset()
    putObjectBuffer.mockReset()
  })

  it("stores a resized copy under the user's avatar prefix and returns its URL", async () => {
    getObjectBuffer.mockResolvedValue(await jpeg(1024, 1024))
    putObjectBuffer.mockResolvedValue(undefined)

    const url = await avatarResizeService.shrinkOwnedAvatarUrl(
      userId,
      `https://cdn.example.com/avatars/${userId}/photo.jpg`,
    )

    expect(getObjectBuffer).toHaveBeenCalledWith(`avatars/${userId}/photo.jpg`)
    const put = putObjectBuffer.mock.calls[0]![0] as { key: string; contentType: string }
    expect(put.key.startsWith(`avatars/${userId}/`)).toBe(true)
    expect(put.key.endsWith(RESIZED_AVATAR_SUFFIX)).toBe(true)
    expect(put.contentType).toBe('image/webp')
    expect(url).toBe(`https://cdn.example.com/${put.key}`)
  })

  it('leaves third-party and other users\' URLs alone', async () => {
    expect(await avatarResizeService.shrinkOwnedAvatarUrl(userId, 'https://lh3.googleusercontent.com/a/x.jpg')).toBeNull()
    expect(
      await avatarResizeService.shrinkOwnedAvatarUrl(userId, 'https://cdn.example.com/avatars/someone-else/p.jpg'),
    ).toBeNull()
    expect(getObjectBuffer).not.toHaveBeenCalled()
  })

  it('does not re-process an avatar it already produced', async () => {
    const url = `https://cdn.example.com/avatars/${userId}/abc${RESIZED_AVATAR_SUFFIX}`
    expect(await avatarResizeService.shrinkOwnedAvatarUrl(userId, url)).toBeNull()
    expect(getObjectBuffer).not.toHaveBeenCalled()
  })

  it('never throws: storage failure keeps the original URL', async () => {
    getObjectBuffer.mockRejectedValue(new Error('S3 down'))
    await expect(
      avatarResizeService.shrinkOwnedAvatarUrl(userId, `https://cdn.example.com/avatars/${userId}/p.jpg`),
    ).resolves.toBeNull()
    expect(putObjectBuffer).not.toHaveBeenCalled()
  })
})
