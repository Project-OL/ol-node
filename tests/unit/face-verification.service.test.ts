import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env', () => ({
  env: {
    REKOGNITION_COLLECTION_ID: 'face-test',
    FACE_REGISTER_RATE_PER_HOUR: 5,
    FACE_VERIFY_RATE_PER_HOUR: 10,
    FACE_MATCH_THRESHOLD_PASS: 90,
    FACE_MATCH_THRESHOLD_REJECT: 70,
    FACE_MIN_DETECT_CONFIDENCE: 98,
    FACE_LIVENESS_REQUIRED: false,
  },
}))

const redisGet = vi.fn()
const redisSet = vi.fn()
const redisEval = vi.fn()
const redisDel = vi.fn()
const redisNx = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    get: redisGet,
    set: redisSet,
    eval: redisEval,
    del: redisDel,
  },
  RedisKeys: {
    faceRegisterLock: (u: string) => `lock:${u}`,
    faceRegisterRateLimit: (u: string) => `rr:${u}`,
    faceRegisterIdem: (u: string, c: string) => `ri:${u}:${c}`,
    faceVerifyRateLimitUser: (u: string) => `vu:${u}`,
    faceVerifyRateLimitIp: (ip: string) => `vi:${ip}`,
    faceVerifyIdem: (u: string, c: string) => `vi:${u}:${c}`,
    faceVerifyLastPass: (u: string) => `vp:${u}`,
  },
}))

const getObjectBuffer = vi.fn()
vi.mock('../../src/services/storage.service', () => ({
  storageService: {
    getObjectBuffer,
    getPresignedPutUrl: vi.fn(),
  },
}))

const detectFacesQuality = vi.fn()
const searchFaceInCollection = vi.fn()
const indexUserFace = vi.fn()
const deleteFaceFromCollection = vi.fn()
vi.mock('../../src/lib/rekognition.client', () => ({
  detectFacesQuality,
  searchFaceInCollection,
  indexUserFace,
  deleteFaceFromCollection,
}))

const repo = {
  getProfileByUserId: vi.fn(),
  createPendingProfile: vi.fn(),
  recordAttempt: vi.fn(),
  touchLastVerifiedAt: vi.fn(),
  revokeProfile: vi.fn(),
  markProfileFailed: vi.fn(),
  markProfileIndexed: vi.fn(),
  findProfileByRekognitionFaceId: vi.fn(),
  markDuplicate: vi.fn(),
}
vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: repo,
}))

describe('faceVerificationService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    redisEval.mockResolvedValue(1)
    redisNx.mockResolvedValue('OK')
    redisSet.mockImplementation((key: string) => {
      if (key.startsWith('lock:')) return redisNx()
      return Promise.resolve('OK')
    })
    redisGet.mockResolvedValue(null)
    getObjectBuffer.mockResolvedValue(Buffer.from('img'))
    repo.recordAttempt.mockResolvedValue({ id: 'attempt-1' })
  })

  it('rejects registration quality when brightness/sharpness low', async () => {
    const { faceVerificationService } = await import('../../src/services/face-verification.service')
    detectFacesQuality.mockResolvedValue({
      FaceDetails: [{ Confidence: 99, Quality: { Brightness: 20, Sharpness: 20 } }],
    })
    await expect(
      faceVerificationService.registerFromUploadedKey(
        'u1',
        { s3Key: 'face/register/u1/a.jpg', clientRequestId: '11111111-1111-1111-1111-111111111111' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'face_quality_rejected' })
  })

  it('passes at threshold boundary 90.0 and fails at 89.9', async () => {
    const { faceVerificationService } = await import('../../src/services/face-verification.service')
    repo.getProfileByUserId.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      status: 'INDEXED',
      rekognitionFaceId: 'f1',
    })

    searchFaceInCollection.mockResolvedValueOnce({ faceId: 'f1', similarity: 89.9, requestId: 'r1' })
    const failRes = await faceVerificationService.verifyFromUploadedKey(
      'u1',
      { s3Key: 'face/verify/u1/a.jpg', clientRequestId: '11111111-1111-1111-1111-111111111111' },
      {},
    )
    expect(failRes.decision).toBe('FAIL')

    searchFaceInCollection.mockResolvedValueOnce({ faceId: 'f1', similarity: 90, requestId: 'r2' })
    const passRes = await faceVerificationService.verifyFromUploadedKey(
      'u1',
      { s3Key: 'face/verify/u1/a.jpg', clientRequestId: '22222222-2222-2222-2222-222222222222' },
      {},
    )
    expect(passRes.decision).toBe('PASS')
  })

  it('returns fail when matched face belongs to another user', async () => {
    const { faceVerificationService } = await import('../../src/services/face-verification.service')
    repo.getProfileByUserId.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      status: 'INDEXED',
      rekognitionFaceId: 'expected-face',
    })
    searchFaceInCollection.mockResolvedValue({ faceId: 'other-face', similarity: 99, requestId: 'r3' })
    const result = await faceVerificationService.verifyFromUploadedKey(
      'u1',
      { s3Key: 'face/verify/u1/a.jpg', clientRequestId: '33333333-3333-3333-3333-333333333333' },
      {},
    )
    expect(result.decision).toBe('FAIL')
  })
})

