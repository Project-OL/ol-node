import {
  FACE_QUALITY_USER_MESSAGES,
  type FaceRegistrationErrorCode,
} from '../constants/face-registration-errors'

const EXTRA_FAILURE_MESSAGES: Record<string, string> = {
  duplicate_face: 'This face matches another indexed account.',
  no_face_indexed: 'Rekognition IndexFaces did not return a face id for this image.',
  replay_or_duplicate_upload_suspected:
    'Upload looks like a replay or duplicate of an existing face image.',
  face_service_timeout: 'Face indexing timed out talking to Rekognition.',
}

export function describeFaceFailureReason(reason: string | null | undefined): string | null {
  if (!reason?.trim()) return null
  const code = reason.trim()
  if (code in FACE_QUALITY_USER_MESSAGES) {
    return FACE_QUALITY_USER_MESSAGES[code as FaceRegistrationErrorCode]
  }
  if (code in EXTRA_FAILURE_MESSAGES) return EXTRA_FAILURE_MESSAGES[code]
  return code.replace(/_/g, ' ')
}

export type FaceStatusExplanation = {
  statusLabel: string
  statusDetail: string
  notIndexedReason: string | null
}

function appendKycNote(detail: string, kycFaceVerified: boolean, status: string | null): string {
  if (!kycFaceVerified || status === 'INDEXED') return detail
  return `${detail} Agency KYC also marked this user as face verified.`
}

export function explainFaceProfileStatus(input: {
  status: string | null | undefined
  failureReason: string | null | undefined
  hasReferenceImage: boolean
  kycFaceVerified: boolean
  isIndexed: boolean
  faceMatchSimilarity?: number | null
  matchedUserName?: string | null
}): FaceStatusExplanation {
  const status = input.status ?? null
  const failureMessage = describeFaceFailureReason(input.failureReason)
  const similarity =
    input.faceMatchSimilarity != null && Number.isFinite(input.faceMatchSimilarity)
      ? `${input.faceMatchSimilarity.toFixed(1)}% similarity`
      : null
  const matchName = input.matchedUserName?.trim() || null

  if (!status) {
    if (input.kycFaceVerified) {
      return {
        statusLabel: 'KYC verified',
        statusDetail: 'No Rekognition face profile. Agency KYC marked this user as face verified.',
        notIndexedReason: 'No Rekognition reference image or indexed face id.',
      }
    }
    return {
      statusLabel: 'Not registered',
      statusDetail: 'This user has not submitted a face verification image.',
      notIndexedReason: null,
    }
  }

  if (status === 'INDEXED') {
    if (!input.isIndexed) {
      const reason =
        'Status is INDEXED but Rekognition face id or reference image is missing, so the face is not searchable.'
      return {
        statusLabel: 'Indexed (incomplete)',
        statusDetail: appendKycNote(reason, input.kycFaceVerified, status),
        notIndexedReason: reason,
      }
    }
    return {
      statusLabel: 'Indexed',
      statusDetail: 'Face is indexed in Rekognition and can be matched.',
      notIndexedReason: null,
    }
  }

  if (status === 'PENDING_INDEX') {
    const reason = input.hasReferenceImage
      ? 'A reference image was saved, but Rekognition has not indexed this face yet. Indexing runs on the face-index worker; the face is not searchable until that completes.'
      : 'Face profile is waiting to be indexed and has no reference image.'
    return {
      statusLabel: 'Pending index',
      statusDetail: appendKycNote(reason, input.kycFaceVerified, status),
      notIndexedReason: reason,
    }
  }

  if (status === 'FAILED') {
    const reason =
      failureMessage ??
      (input.hasReferenceImage
        ? 'Indexing or validation failed for this reference image.'
        : 'Face indexing failed.')
    return {
      statusLabel: 'Failed',
      statusDetail: appendKycNote(reason, input.kycFaceVerified, status),
      notIndexedReason: reason,
    }
  }

  if (status === 'DUPLICATE_FACE') {
    const parts = [
      'This face matches another account, so it was not indexed.',
      similarity ? `(${similarity})` : null,
      matchName ? `Matched user: ${matchName}.` : null,
    ].filter(Boolean)
    const reason = parts.join(' ')
    return {
      statusLabel: 'Duplicate face',
      statusDetail: appendKycNote(reason, input.kycFaceVerified, status),
      notIndexedReason: reason,
    }
  }

  if (status === 'REVOKED') {
    const reason = 'Face profile was revoked. The user must re-register to be indexed again.'
    return {
      statusLabel: 'Revoked',
      statusDetail: appendKycNote(reason, input.kycFaceVerified, status),
      notIndexedReason: reason,
    }
  }

  const fallback = failureMessage ?? `Face profile status is ${status}.`
  return {
    statusLabel: status.replace(/_/g, ' '),
    statusDetail: appendKycNote(fallback, input.kycFaceVerified, status),
    notIndexedReason: input.isIndexed ? null : fallback,
  }
}
