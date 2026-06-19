import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env', () => ({
  env: {
    FACE_MIN_DETECT_CONFIDENCE: 98,
    FACE_MIN_BRIGHTNESS: 30,
    FACE_MIN_SHARPNESS: 30,
    FACE_MAX_LANDMARKS_MISSING: 2,
    FACE_CHECK_MINOR_AGE: true,
    FACE_MIN_USER_AGE: 16,
    FACE_CONTENT_MODERATION_ENABLED: false,
    FACE_DUPLICATE_CHECK_ENABLED: true,
    FACE_GENDER_AUTO_UPDATE_ENABLED: false,
    FACE_GARISH_SATURATION_MAX: 85,
    FACE_MONOCHROME_SATURATION_MAX: 10,
    REKOGNITION_COLLECTION_ID: 'test-collection',
    FACE_MATCH_THRESHOLD_PASS: 90,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}))

const detectFacesQuality = vi.fn()
const searchFaceInCollection = vi.fn()
vi.mock('../../src/lib/rekognition.client', () => ({
  detectFacesQuality,
  searchFaceInCollection,
  detectModerationLabels: vi.fn(),
  detectModerationLabelsFromS3: vi.fn(),
  recognizeCelebrities: vi.fn(),
}))

vi.mock('../../src/services/storage.service', () => ({
  storageService: { getObjectBuffer: vi.fn().mockResolvedValue(Buffer.from('jpeg')) },
}))

vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: {
    findProfileByRekognitionFaceId: vi.fn(),
  },
}))

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: { findById: vi.fn() },
}))

vi.mock('../../src/config/database', () => ({
  prisma: { user: { update: vi.fn() } },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn() },
}))

vi.mock('../../src/utils/face-image-heuristics', () => ({
  analyzeImageHeuristics: vi.fn(() => ({
    isMonochrome: false,
    hasBorders: false,
    isPrintedPhoto: false,
    faceSaturation: 40,
    avgSaturation: 50,
  })),
  countMissingKeyLandmarks: vi.fn(() => 0),
  normalizeRekognitionMetric: (v: number) => Math.round(v),
}))

describe('faceRegistrationValidationService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('rejects blurred images', async () => {
    const { faceRegistrationValidationService } = await import(
      '../../src/services/face-registration/face-registration.validation.service'
    )
    detectFacesQuality.mockResolvedValue({
      FaceDetails: [{ Confidence: 99, Quality: { Brightness: 80, Sharpness: 15 } }],
    })
    const result = await faceRegistrationValidationService.validateImageQuality(new Uint8Array([1, 2, 3]))
    expect(result.isValid).toBe(false)
    expect(result.failure?.code).toBe('FACE_QUALITY_BLURRED')
  })

  it('rejects multiple faces', async () => {
    const { faceRegistrationValidationService } = await import(
      '../../src/services/face-registration/face-registration.validation.service'
    )
    detectFacesQuality.mockResolvedValue({
      FaceDetails: [{ Confidence: 99 }, { Confidence: 99 }],
    })
    const result = await faceRegistrationValidationService.validateImageQuality(new Uint8Array([1, 2, 3]))
    expect(result.isValid).toBe(false)
    expect(result.failure?.code).toBe('FACE_QUALITY_MULTIPLE_FACES')
  })

  it('rejects minor users when age range low is below threshold', async () => {
    const { faceRegistrationValidationService } = await import(
      '../../src/services/face-registration/face-registration.validation.service'
    )
    detectFacesQuality.mockResolvedValue({
      FaceDetails: [
        {
          Confidence: 99,
          Quality: { Brightness: 80, Sharpness: 80 },
          AgeRange: { Low: 12, High: 16 },
          Landmarks: [],
        },
      ],
    })
    const result = await faceRegistrationValidationService.validateImageQuality(new Uint8Array([1, 2, 3]), {
      checkMinorAge: true,
    })
    expect(result.isValid).toBe(false)
    expect(result.failure?.code).toBe('FACE_QUALITY_MINOR')
  })

  it('passes quality checks for a good single face', async () => {
    const { faceRegistrationValidationService } = await import(
      '../../src/services/face-registration/face-registration.validation.service'
    )
    detectFacesQuality.mockResolvedValue({
      FaceDetails: [
        {
          Confidence: 99,
          Quality: { Brightness: 80, Sharpness: 80 },
          AgeRange: { Low: 20, High: 30 },
          Landmarks: [],
        },
      ],
    })
    const result = await faceRegistrationValidationService.validateImageQuality(new Uint8Array([1, 2, 3]))
    expect(result.isValid).toBe(true)
    expect(result.qualityChecks?.faceDetected).toBe(true)
  })
})
