import type { FaceDetail } from '@aws-sdk/client-rekognition'
import { AppError } from '../../middlewares/errorHandler'
import { env } from '../../config/env'
import { s3Bucket } from '../../config/s3'
import {
  detectFacesQuality,
  detectModerationLabels,
  detectModerationLabelsFromS3,
  recognizeCelebrities,
  searchFaceInCollection,
} from '../../lib/rekognition.client'
import {
  FACE_QUALITY_RECOMMENDATIONS,
  FACE_QUALITY_USER_MESSAGES,
  FACE_REGISTRATION_ERRORS,
  type FaceRegistrationErrorCode,
} from '../../constants/face-registration-errors'
import { faceVerificationRepository } from '../../repositories/faceVerification.repository'
import { userRepository } from '../../repositories/user.repository'
import { prisma } from '../../config/database'
import {
  buildMatchedUserSummary,
  duplicateDetailsForAppError,
} from './face-duplicate-match.service'
import {
  analyzeImageHeuristics,
  countMissingKeyLandmarks,
  normalizeRekognitionMetric,
} from '../../utils/face-image-heuristics'
import {
  checkContentPolicy,
  checkImageForNudity,
  detectTextOrWatermark,
  getFullModerationLabels,
} from './face-registration-moderation.service'
import { storageService } from '../storage.service'
import { auditService } from '../audit.service'

export type QualityChecksPassed = {
  faceDetected: boolean
  singleFace: boolean
  brightness: number
  sharpness: number
  confidence: number
  noBlur: boolean
  noWatermark: boolean
  noBorders: boolean
  notMonochrome: boolean
  notPrintedPhoto: boolean
  noNudity: boolean
  ageEligible: boolean
  faceFullyVisible: boolean
}

export type ValidationFailure = {
  code: FaceRegistrationErrorCode
  failedChecks: string[]
  qualityMetrics?: Record<string, number>
  recommendation?: string
}

export type DuplicateCheckResult = {
  isDuplicate: boolean
  isSameUser: boolean
  matchSimilarity: number
  matchedUserId: string | null
  matchedUser?: {
    userId: string
    name: string
    displayPublicId: string | null
    authMethod: string
    authValue: string
  }
}

export type FullValidationResult = {
  isValid: boolean
  primaryFailureReason?: FaceRegistrationErrorCode
  errorCode?: FaceRegistrationErrorCode
  details?: ValidationFailure
  qualityChecksPassed?: QualityChecksPassed
  qualityScore?: number
  detectedGender?: string | null
  genderUpdated?: boolean
  previousGender?: string | null
  moderationLabels?: { label: string; confidence: number }[]
  duplicateMatch?: DuplicateCheckResult | null
  faceDetail?: FaceDetail
}

export type ValidationPipelineOptions = {
  checkMinorAge?: boolean
  checkDuplicate?: boolean
  skipGenderUpdate?: boolean
  livenessPassed?: boolean
}

function mapRekognitionGender(face: FaceDetail): string | null {
  const g = face.Gender?.Value
  if (!g) return null
  const v = String(g).toUpperCase()
  if (v === 'MALE') return 'male'
  if (v === 'FEMALE') return 'female'
  return 'other'
}

function buildQualityMetrics(face: FaceDetail): Record<string, number> {
  return {
    sharpness: normalizeRekognitionMetric(face.Quality?.Sharpness),
    brightness: normalizeRekognitionMetric(face.Quality?.Brightness),
    faceConfidence: Math.round(face.Confidence ?? 0),
  }
}

function failure(
  code: FaceRegistrationErrorCode,
  failedChecks: string[],
  face?: FaceDetail,
): ValidationFailure {
  return {
    code,
    failedChecks,
    qualityMetrics: face ? buildQualityMetrics(face) : undefined,
    recommendation: FACE_QUALITY_RECOMMENDATIONS[code],
  }
}

async function loadBytes(s3KeyOrBytes: string | Uint8Array): Promise<Uint8Array> {
  if (typeof s3KeyOrBytes !== 'string') return s3KeyOrBytes
  const buf = await storageService.getObjectBuffer(s3KeyOrBytes)
  return new Uint8Array(buf)
}

export const faceRegistrationValidationService = {
  async validateImageQuality(
    s3KeyOrBytes: string | Uint8Array,
    options?: { checkMinorAge?: boolean; livenessPassed?: boolean },
  ): Promise<{
    isValid: boolean
    failure?: ValidationFailure
    face?: FaceDetail
    qualityChecks?: QualityChecksPassed
    qualityScore?: number
  }> {
    const imageBytes = await loadBytes(s3KeyOrBytes)
    const detect = await detectFacesQuality(imageBytes)
    const faces = detect.FaceDetails ?? []
    const s3Key = typeof s3KeyOrBytes === 'string' ? s3KeyOrBytes : undefined

    if (faces.length === 0) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_NO_FACE, ['NO_FACE']),
      }
    }
    if (faces.length > 1) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_MULTIPLE_FACES, ['MULTIPLE_FACES']),
      }
    }

    const face = faces[0]!
    const brightness = normalizeRekognitionMetric(face.Quality?.Brightness)
    const sharpness = normalizeRekognitionMetric(face.Quality?.Sharpness)
    const confidence = Math.round(face.Confidence ?? 0)

    if (confidence < env.FACE_MIN_DETECT_CONFIDENCE) {
      return {
        isValid: false,
        failure: failure(
          FACE_REGISTRATION_ERRORS.FACE_QUALITY_CONFIDENCE_TOO_LOW,
          ['CONFIDENCE'],
          face,
        ),
        face,
      }
    }
    if (sharpness < env.FACE_MIN_SHARPNESS) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_BLURRED, ['BLUR'], face),
        face,
      }
    }
    if (brightness < env.FACE_MIN_BRIGHTNESS) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_LOW_LIGHT, ['BRIGHTNESS'], face),
        face,
      }
    }

    const missingLandmarks = countMissingKeyLandmarks(face.Landmarks)
    if (missingLandmarks > env.FACE_MAX_LANDMARKS_MISSING) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_HALF_COVERED, ['LANDMARKS'], face),
        face,
      }
    }

    if (options?.checkMinorAge !== false && env.FACE_CHECK_MINOR_AGE) {
      const ageLow = face.AgeRange?.Low
      if (ageLow != null && ageLow < env.FACE_MIN_USER_AGE) {
        return {
          isValid: false,
          failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_MINOR, ['AGE'], face),
          face,
        }
      }
    }

    const heuristics = analyzeImageHeuristics(imageBytes, face)
    if (heuristics.isMonochrome) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_MONOCHROME, ['MONOCHROME'], face),
        face,
      }
    }
    if (heuristics.hasBorders) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_BORDERS_DETECTED, ['BORDERS'], face),
        face,
      }
    }

    if (
      heuristics.faceSaturation != null &&
      heuristics.faceSaturation > env.FACE_GARISH_SATURATION_MAX &&
      confidence < 80
    ) {
      return {
        isValid: false,
        failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_GARISH, ['GARISH'], face),
        face,
      }
    }

    if (env.FACE_CONTENT_MODERATION_ENABLED && s3Key) {
      const hasText = await detectTextOrWatermark(s3Key)
      if (hasText) {
        return {
          isValid: false,
          failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_TEXT_WATERMARK, ['TEXT'], face),
          face,
        }
      }
      const nudity = await checkImageForNudity(s3Key)
      if (nudity.isNudityDetected) {
        return {
          isValid: false,
          failure: failure(FACE_REGISTRATION_ERRORS.FACE_QUALITY_INDECENT, ['NUDITY'], face),
          face,
        }
      }
      const policy = await checkContentPolicy(s3Key)
      if (policy.violated) {
        return {
          isValid: false,
          failure: failure(
            FACE_REGISTRATION_ERRORS.FACE_QUALITY_CONTENT_POLICY,
            ['CONTENT_POLICY'],
            face,
          ),
          face,
        }
      }
    }

    if (!options?.livenessPassed && heuristics.isPrintedPhoto) {
      try {
        const celeb = await recognizeCelebrities(imageBytes)
        const hasCeleb = (celeb.CelebrityFaces?.length ?? 0) > 0
        if (!hasCeleb) {
          return {
            isValid: false,
            failure: failure(
              FACE_REGISTRATION_ERRORS.FACE_QUALITY_PRINTED_PHOTO,
              ['PRINTED_PHOTO'],
              face,
            ),
            face,
          }
        }
      } catch {
        return {
          isValid: false,
          failure: failure(
            FACE_REGISTRATION_ERRORS.FACE_QUALITY_PRINTED_PHOTO,
            ['PRINTED_PHOTO'],
            face,
          ),
          face,
        }
      }
    }

    const qualityScore = (brightness + sharpness) / 2
    const qualityChecks: QualityChecksPassed = {
      faceDetected: true,
      singleFace: true,
      brightness,
      sharpness,
      confidence,
      noBlur: sharpness >= env.FACE_MIN_SHARPNESS,
      noWatermark: true,
      noBorders: !heuristics.hasBorders,
      notMonochrome: !heuristics.isMonochrome,
      notPrintedPhoto: !heuristics.isPrintedPhoto,
      noNudity: true,
      ageEligible: true,
      faceFullyVisible: missingLandmarks <= env.FACE_MAX_LANDMARKS_MISSING,
    }

    return { isValid: true, face, qualityChecks, qualityScore }
  },

  checkForNudity: checkImageForNudity,
  checkContentPolicy,

  async checkDuplicateFace(
    s3KeyOrBytes: string | Uint8Array,
    userId: string,
  ): Promise<DuplicateCheckResult | null> {
    if (!env.FACE_DUPLICATE_CHECK_ENABLED) return null
    const imageBytes = await loadBytes(s3KeyOrBytes)
    const match = await searchFaceInCollection({
      imageBytes,
      collectionId: env.REKOGNITION_COLLECTION_ID,
      threshold: Number(env.FACE_MATCH_THRESHOLD_PASS),
    })
    if (!match) return null

    const ownerProfile = await faceVerificationRepository.findProfileByRekognitionFaceId(
      match.faceId,
    )
    const matchedUserId = ownerProfile?.userId ?? null
    const isSameUser = matchedUserId === userId

    if (isSameUser) {
      return {
        isDuplicate: true,
        isSameUser: true,
        matchSimilarity: match.similarity,
        matchedUserId,
      }
    }

    let matchedUser: DuplicateCheckResult['matchedUser']
    if (matchedUserId) {
      matchedUser = (await buildMatchedUserSummary(matchedUserId)) ?? undefined
    }

    return {
      isDuplicate: true,
      isSameUser: false,
      matchSimilarity: match.similarity,
      matchedUserId,
      matchedUser,
    }
  },

  async detectGender(
    s3KeyOrBytes: string | Uint8Array,
  ): Promise<{ gender: string | null; confidence: number }> {
    const imageBytes = await loadBytes(s3KeyOrBytes)
    const detect = await detectFacesQuality(imageBytes)
    const face = detect.FaceDetails?.[0]
    return {
      gender: face ? mapRekognitionGender(face) : null,
      confidence: face?.Gender?.Confidence ?? 0,
    }
  },

  async runFullValidationPipeline(
    s3KeyOrBytes: string | Uint8Array,
    userId: string,
    options?: ValidationPipelineOptions,
  ): Promise<FullValidationResult> {
    const s3Key = typeof s3KeyOrBytes === 'string' ? s3KeyOrBytes : undefined
    const quality = await this.validateImageQuality(s3KeyOrBytes, {
      checkMinorAge: options?.checkMinorAge,
      livenessPassed: options?.livenessPassed,
    })

    if (!quality.isValid || !quality.face) {
      const code = quality.failure?.code ?? FACE_REGISTRATION_ERRORS.FACE_VALIDATION_FAILED
      return {
        isValid: false,
        primaryFailureReason: code,
        errorCode: code,
        details: quality.failure,
      }
    }

    let moderationLabels: { label: string; confidence: number }[] | undefined
    if (env.FACE_CONTENT_MODERATION_ENABLED) {
      try {
        const bucket = s3Bucket?.trim()
        let modRes
        if (bucket && s3Key) {
          try {
            modRes = await detectModerationLabelsFromS3(bucket, s3Key)
          } catch {
            modRes = await detectModerationLabels(await loadBytes(s3KeyOrBytes))
          }
        } else {
          modRes = await detectModerationLabels(await loadBytes(s3KeyOrBytes))
        }
        moderationLabels = getFullModerationLabels(modRes.ModerationLabels)
      } catch {
        /* non-fatal */
      }
    }

    const duplicate =
      options?.checkDuplicate !== false ? await this.checkDuplicateFace(s3KeyOrBytes, userId) : null

    if (duplicate?.isDuplicate && !duplicate.isSameUser) {
      return {
        isValid: false,
        primaryFailureReason: FACE_REGISTRATION_ERRORS.FACE_DUPLICATE_IDENTITY,
        errorCode: FACE_REGISTRATION_ERRORS.FACE_DUPLICATE_IDENTITY,
        details: {
          code: FACE_REGISTRATION_ERRORS.FACE_DUPLICATE_IDENTITY,
          failedChecks: ['DUPLICATE'],
          recommendation: FACE_QUALITY_RECOMMENDATIONS.FACE_DUPLICATE_IDENTITY,
        },
        duplicateMatch: duplicate,
        qualityChecksPassed: quality.qualityChecks,
        qualityScore: quality.qualityScore,
        moderationLabels,
        faceDetail: quality.face,
      }
    }

    const detectedGender = mapRekognitionGender(quality.face)
    let genderUpdated = false
    let previousGender: string | null = null

    if (env.FACE_GENDER_AUTO_UPDATE_ENABLED && !options?.skipGenderUpdate && detectedGender) {
      const user = await userRepository.findById(userId)
      previousGender = user?.gender ?? null
      const normalizedPrev = (previousGender ?? '').toLowerCase()
      if (normalizedPrev && normalizedPrev !== detectedGender) {
        await prisma.user.update({
          where: { id: userId },
          data: { gender: detectedGender },
        })
        genderUpdated = true
        auditService.log({
          userId,
          actionType: 'FACE_GENDER_MISMATCH_AUTO_CORRECTED',
          actionStatus: 'success',
          actionDetails: {
            detectedGender,
            previousGender,
            updatedGender: detectedGender,
          },
        })
      }
    }

    return {
      isValid: true,
      qualityChecksPassed: quality.qualityChecks,
      qualityScore: quality.qualityScore,
      detectedGender,
      genderUpdated,
      previousGender,
      moderationLabels,
      duplicateMatch: duplicate,
      faceDetail: quality.face,
    }
  },

  toAppError(result: FullValidationResult): AppError {
    const code = result.errorCode ?? FACE_REGISTRATION_ERRORS.FACE_VALIDATION_FAILED
    const message =
      FACE_QUALITY_USER_MESSAGES[code] ?? FACE_QUALITY_USER_MESSAGES.FACE_VALIDATION_FAILED
    const details: Record<string, unknown> = {
      ...(result.details ?? {}),
    }
    if (result.duplicateMatch && !result.duplicateMatch.isSameUser) {
      Object.assign(
        details,
        duplicateDetailsForAppError({
          matchedUser: result.duplicateMatch.matchedUser ?? null,
          matchedUserId: result.duplicateMatch.matchedUserId,
          matchSimilarity: result.duplicateMatch.matchSimilarity,
          action:
            FACE_QUALITY_RECOMMENDATIONS.FACE_DUPLICATE_IDENTITY ??
            'Contact support if you believe this is an error.',
        }),
      )
    }
    return new AppError(409, message, code, details)
  },
}
