import { describeFaceFailureReason } from './face-profile-status'

const LIVE_PHOTO_FAILURE_MESSAGES: Record<string, string> = {
  face_confidence_low: 'Face detection confidence was too low.',
  sunglasses_not_allowed: 'Sunglasses are not allowed in the live photo.',
  eyes_must_be_open: 'Eyes must be open in the live photo.',
  image_quality_low: 'Image brightness or sharpness was too low.',
  face_too_small: 'The face occupies too little of the image.',
  face_profile_not_indexed: 'The user has no indexed face profile to compare against.',
  live_object_missing: 'The uploaded live photo object was missing from storage.',
  invalid_image_format: 'The uploaded file is not a valid image format.',
  rekognition_detect_error: 'Rekognition failed while detecting faces in the live photo.',
  rekognition_compare_error:
    'Rekognition failed while comparing the live photo to the face profile.',
  no_face_in_live_image: 'No face was detected in the live photo.',
  multiple_faces_in_live_image: 'Multiple faces were detected; a solo photo is required.',
  below_similarity_threshold: 'The live photo did not match the indexed face closely enough.',
}

export function describeLivePhotoFailureReason(reason: string | null | undefined): string | null {
  if (!reason?.trim()) return null
  const code = reason.trim()
  if (code in LIVE_PHOTO_FAILURE_MESSAGES) return LIVE_PHOTO_FAILURE_MESSAGES[code]
  return describeFaceFailureReason(code)
}

export type LivePhotoStatusExplanation = {
  statusLabel: string
  statusDetail: string
  verdictReason: string | null
}

export function explainLivePhotoStatus(input: {
  verificationState: string | null | undefined
  failedReason: string | null | undefined
  replaceFailedReason: string | null | undefined
  hasUploadedImage: boolean
  isVerified: boolean
  replaceInProgress?: boolean
  similarityScore?: number | null
}): LivePhotoStatusExplanation {
  const state = input.verificationState ?? null
  const failureMessage = describeLivePhotoFailureReason(input.failedReason)
  const replaceFailureMessage = describeLivePhotoFailureReason(input.replaceFailedReason)
  const similarity =
    input.similarityScore != null && Number.isFinite(input.similarityScore)
      ? `${Number(input.similarityScore).toFixed(1)}% similarity`
      : null

  if (!state || state === 'NOT_UPLOADED') {
    return {
      statusLabel: 'Not uploaded',
      statusDetail: 'This user has not uploaded a live photo.',
      verdictReason: null,
    }
  }

  if (state === 'VERIFIED' || input.isVerified) {
    const verifiedDetail = similarity
      ? `Live photo is verified against the indexed face (${similarity}).`
      : 'Live photo is verified against the indexed face.'
    if (input.replaceInProgress) {
      return {
        statusLabel: 'Verified',
        statusDetail: `${verifiedDetail} A replacement upload is being verified.`,
        verdictReason: null,
      }
    }
    if (replaceFailureMessage) {
      return {
        statusLabel: 'Verified',
        statusDetail: `${verifiedDetail} A later replacement attempt failed: ${replaceFailureMessage}`,
        verdictReason: replaceFailureMessage,
      }
    }
    return {
      statusLabel: 'Verified',
      statusDetail: verifiedDetail,
      verdictReason: null,
    }
  }

  if (state === 'FAILED') {
    const reason = failureMessage ?? 'Live photo verification failed.'
    return {
      statusLabel: 'Failed',
      statusDetail: reason,
      verdictReason: reason,
    }
  }

  if (state === 'REJECTED') {
    const reason = failureMessage ?? 'Live photo was rejected by content moderation.'
    return {
      statusLabel: 'Rejected',
      statusDetail: reason,
      verdictReason: reason,
    }
  }

  if (state === 'PENDING_UPLOAD') {
    const reason = input.hasUploadedImage
      ? 'A live photo key was issued, but verification has not been requested yet.'
      : 'Waiting for the user to upload a live photo.'
    return {
      statusLabel: 'Pending upload',
      statusDetail: reason,
      verdictReason: reason,
    }
  }

  if (state === 'PENDING_VERIFICATION') {
    const reason =
      'A replacement live photo is waiting to be verified. The previous verified photo is still shown.'
    return {
      statusLabel: 'Pending verification',
      statusDetail: reason,
      verdictReason: reason,
    }
  }

  if (state === 'PROCESSING') {
    const reason = 'Live photo verification is in progress on the face-index worker.'
    return {
      statusLabel: 'Processing',
      statusDetail: reason,
      verdictReason: reason,
    }
  }

  const fallback = failureMessage ?? `Live photo status is ${state}.`
  return {
    statusLabel: state.replace(/_/g, ' '),
    statusDetail: fallback,
    verdictReason: input.isVerified ? null : fallback,
  }
}
