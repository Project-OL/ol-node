import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisSet = vi.fn()
const redisDel = vi.fn()
vi.mock('../../src/config/redis', () => ({
  RedisKeys: { livePhotoVerifyLock: (u: string) => `lock:${u}` },
  redisClient: {
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
  },
}))

const findByUserId = vi.fn()
const markFailed = vi.fn()
const markRejected = vi.fn()
const abortReplace = vi.fn()
const createAttempt = vi.fn()
const completeVerification = vi.fn()
vi.mock('../../src/repositories/livePhoto.repository', () => ({
  livePhotoRepository: {
    findByUserId: (...a: unknown[]) => findByUserId(...a),
    markFailed: (...a: unknown[]) => markFailed(...a),
    markRejected: (...a: unknown[]) => markRejected(...a),
    abortReplace: (...a: unknown[]) => abortReplace(...a),
    createAttempt: (...a: unknown[]) => createAttempt(...a),
    completeVerification: (...a: unknown[]) => completeVerification(...a),
  },
}))

vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: { getProfileByUserId: vi.fn() },
}))
vi.mock('../../src/services/storage.service', () => ({
  storageService: { headObjectMetadata: vi.fn(), getObjectBuffer: vi.fn(), deleteObject: vi.fn() },
}))
vi.mock('../../src/services/live-photo/live-photo-cache', () => ({
  bustLivePhotoCaches: vi.fn(async () => undefined),
}))
const enqueuePurge = vi.fn()
vi.mock('../../src/queues/live-photo.queue', () => ({
  enqueueLivePhotoS3Purge: (...a: unknown[]) => enqueuePurge(...a),
}))
vi.mock('../../src/lib/rekognition.client', () => ({
  compareFacesIndexedToLive: vi.fn(),
  detectFacesQuality: vi.fn(),
  isRekognitionInvalidImageFormatError: (err: unknown) =>
    /invalid image format/i.test(String((err as Error)?.message ?? '')),
}))
const checkImageForNudity = vi.fn()
const checkContentPolicy = vi.fn()
vi.mock('../../src/services/face-registration/face-registration-moderation.service', () => ({
  checkImageForNudity: (...a: unknown[]) => checkImageForNudity(...a),
  checkContentPolicy: (...a: unknown[]) => checkContentPolicy(...a),
}))

import {
  LivePhotoVerifyLockContendedError,
  onLivePhotoVerifyJobFailed,
  processLivePhotoVerifyJob,
} from '../../src/jobs/live-photo-verify.job'
import { LIVE_PHOTO_VERIFY_JOB } from '../../src/queues/live-photo.constants'

const USER = 'u-1'
const KEY = `live-photo/${USER}/2026/11/new.jpg`

function job(over: Record<string, unknown> = {}) {
  return {
    name: LIVE_PHOTO_VERIFY_JOB,
    data: { userId: USER, s3Key: KEY, generation: 2 },
    opts: { attempts: 6 },
    attemptsMade: 6,
    timestamp: Date.now(),
    ...over,
  } as never
}

const replaceRow = {
  id: 'lp-1',
  userId: USER,
  s3Key: `live-photo/${USER}/2026/08/old.jpg`,
  pendingS3Key: KEY,
  verifiedAt: new Date('2026-08-26'),
  verificationState: 'PROCESSING',
  verifyGeneration: 2,
}
const firstRow = {
  ...replaceRow,
  s3Key: KEY,
  pendingS3Key: null,
  verifiedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  redisSet.mockResolvedValue('OK')
  redisDel.mockResolvedValue(1)
  abortReplace.mockResolvedValue({ pendingKeyToPurge: KEY })
  createAttempt.mockResolvedValue({})
})

describe('processLivePhotoVerifyJob', () => {
  it('throws on lock contention so BullMQ retries instead of completing silently', async () => {
    redisSet.mockResolvedValue(null)
    await expect(processLivePhotoVerifyJob(job())).rejects.toBeInstanceOf(
      LivePhotoVerifyLockContendedError,
    )
    expect(findByUserId).not.toHaveBeenCalled()
    expect(redisDel).not.toHaveBeenCalled()
  })

  it('invalid image format from moderation aborts a replace and keeps the old photo', async () => {
    findByUserId.mockResolvedValue(replaceRow)
    checkImageForNudity.mockRejectedValue(new Error('Request has invalid image format'))
    await expect(processLivePhotoVerifyJob(job())).resolves.toBeUndefined()
    expect(abortReplace).toHaveBeenCalledWith(USER, 'invalid_image_format')
    expect(markFailed).not.toHaveBeenCalled()
    expect(enqueuePurge).toHaveBeenCalledWith([KEY])
    expect(redisDel).toHaveBeenCalledWith(`lock:${USER}`)
  })

  it('invalid image format from moderation marks a first upload FAILED', async () => {
    findByUserId.mockResolvedValue(firstRow)
    checkImageForNudity.mockResolvedValue({ isNudityDetected: false, labels: [] })
    checkContentPolicy.mockRejectedValue(new Error('Request has invalid image format'))
    await processLivePhotoVerifyJob(job())
    expect(markFailed).toHaveBeenCalledWith(USER, 'invalid_image_format')
    expect(abortReplace).not.toHaveBeenCalled()
  })

  it('rethrows other moderation errors so the job retries', async () => {
    findByUserId.mockResolvedValue(replaceRow)
    checkImageForNudity.mockRejectedValue(new Error('ThrottlingException'))
    await expect(processLivePhotoVerifyJob(job())).rejects.toThrow('ThrottlingException')
    expect(abortReplace).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })
})

describe('onLivePhotoVerifyJobFailed', () => {
  it('does nothing while retries remain', async () => {
    await onLivePhotoVerifyJobFailed(job({ attemptsMade: 3 }), new Error('boom'))
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it('on the final attempt aborts a stuck replace (old photo stays VERIFIED)', async () => {
    findByUserId.mockResolvedValue(replaceRow)
    await onLivePhotoVerifyJobFailed(job(), new Error('S3 read timeout'))
    expect(abortReplace).toHaveBeenCalledWith(USER, 'verify_job_failed')
    expect(createAttempt).toHaveBeenCalled()
  })

  it('on the final attempt marks a stuck first upload FAILED', async () => {
    findByUserId.mockResolvedValue(firstRow)
    await onLivePhotoVerifyJobFailed(job(), new LivePhotoVerifyLockContendedError())
    expect(markFailed).toHaveBeenCalledWith(USER, 'verify_job_failed')
  })

  it('maps an exhausted invalid-format error to invalid_image_format', async () => {
    findByUserId.mockResolvedValue(firstRow)
    await onLivePhotoVerifyJobFailed(job(), new Error('Request has invalid image format'))
    expect(markFailed).toHaveBeenCalledWith(USER, 'invalid_image_format')
  })

  it('leaves the row alone when a newer generation or other state took over', async () => {
    findByUserId.mockResolvedValue({ ...replaceRow, verifyGeneration: 3 })
    await onLivePhotoVerifyJobFailed(job(), new Error('boom'))
    findByUserId.mockResolvedValue({ ...replaceRow, verificationState: 'VERIFIED' })
    await onLivePhotoVerifyJobFailed(job(), new Error('boom'))
    expect(abortReplace).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })
})
