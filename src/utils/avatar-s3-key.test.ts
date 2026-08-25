import { describe, expect, it } from 'vitest'
import { parseOwnedAvatarS3Key } from './avatar-s3-key'

const userId = 'abc-123'

describe('parseOwnedAvatarS3Key', () => {
  it('extracts key from virtual-hosted S3 URL', () => {
    expect(
      parseOwnedAvatarS3Key(
        `https://bucket.s3.ap-south-1.amazonaws.com/avatars/${userId}/uuid.jpg`,
        userId,
      ),
    ).toBe(`avatars/${userId}/uuid.jpg`)
  })

  it('extracts key from CloudFront URL', () => {
    expect(
      parseOwnedAvatarS3Key(`https://cdn.example.com/avatars/${userId}/v1.webp`, userId),
    ).toBe(`avatars/${userId}/v1.webp`)
  })

  it('ignores query strings', () => {
    expect(
      parseOwnedAvatarS3Key(
        `https://cdn.example.com/avatars/${userId}/file.png?x=1`,
        userId,
      ),
    ).toBe(`avatars/${userId}/file.png`)
  })

  it('rejects another user prefix', () => {
    expect(
      parseOwnedAvatarS3Key(
        'https://cdn.example.com/avatars/other-user/file.jpg',
        userId,
      ),
    ).toBeNull()
  })

  it('rejects nested paths and traversal', () => {
    expect(
      parseOwnedAvatarS3Key(
        `https://cdn.example.com/avatars/${userId}/nested/file.jpg`,
        userId,
      ),
    ).toBeNull()
    expect(
      parseOwnedAvatarS3Key(
        `https://cdn.example.com/avatars/${userId}/../secret.jpg`,
        userId,
      ),
    ).toBeNull()
  })

  it('accepts path-style S3 URLs that still contain avatars/{userId}/', () => {
    expect(
      parseOwnedAvatarS3Key(
        `https://s3.ap-south-1.amazonaws.com/my-bucket/avatars/${userId}/a.jpg`,
        userId,
      ),
    ).toBe(`avatars/${userId}/a.jpg`)
  })

  it('rejects non-avatar URLs and invalid URLs', () => {
    expect(parseOwnedAvatarS3Key('https://google.com/photo.jpg', userId)).toBeNull()
    expect(parseOwnedAvatarS3Key('not-a-url', userId)).toBeNull()
    expect(parseOwnedAvatarS3Key(`https://cdn.example.com/messaging/${userId}/x.jpg`, userId)).toBeNull()
  })
})
