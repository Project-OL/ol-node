/** Face registration / verification quality and policy error codes (HTTP 409 unless noted). */
export const FACE_REGISTRATION_ERRORS = {
  FACE_QUALITY_NO_FACE: 'FACE_QUALITY_NO_FACE',
  FACE_QUALITY_MULTIPLE_FACES: 'FACE_QUALITY_MULTIPLE_FACES',
  FACE_QUALITY_HALF_COVERED: 'FACE_QUALITY_HALF_COVERED',
  FACE_QUALITY_BLURRED: 'FACE_QUALITY_BLURRED',
  FACE_QUALITY_LOW_LIGHT: 'FACE_QUALITY_LOW_LIGHT',
  FACE_QUALITY_TEXT_WATERMARK: 'FACE_QUALITY_TEXT_WATERMARK',
  FACE_QUALITY_BORDERS_DETECTED: 'FACE_QUALITY_BORDERS_DETECTED',
  FACE_QUALITY_MONOCHROME: 'FACE_QUALITY_MONOCHROME',
  FACE_QUALITY_PRINTED_PHOTO: 'FACE_QUALITY_PRINTED_PHOTO',
  FACE_QUALITY_INDECENT: 'FACE_QUALITY_INDECENT',
  FACE_QUALITY_GARISH: 'FACE_QUALITY_GARISH',
  FACE_QUALITY_MINOR: 'FACE_QUALITY_MINOR',
  FACE_QUALITY_CONFIDENCE_TOO_LOW: 'FACE_QUALITY_CONFIDENCE_TOO_LOW',
  FACE_QUALITY_CONTENT_POLICY: 'FACE_QUALITY_CONTENT_POLICY',
  FACE_DUPLICATE_IDENTITY: 'FACE_DUPLICATE_IDENTITY',
  FACE_VALIDATION_FAILED: 'FACE_VALIDATION_FAILED',
} as const

export type FaceRegistrationErrorCode =
  (typeof FACE_REGISTRATION_ERRORS)[keyof typeof FACE_REGISTRATION_ERRORS]

export const FACE_QUALITY_USER_MESSAGES: Record<FaceRegistrationErrorCode, string> = {
  FACE_QUALITY_NO_FACE:
    'No face detected. Ensure your face is centered, well lit, and fully in frame.',
  FACE_QUALITY_MULTIPLE_FACES:
    'Multiple faces detected. Please take a solo photo with only your face visible.',
  FACE_QUALITY_HALF_COVERED:
    'Part of your face is covered. Remove masks, hands, or hair from your face and try again.',
  FACE_QUALITY_BLURRED:
    'Image is too blurred. Please ensure good lighting and hold your device steady.',
  FACE_QUALITY_LOW_LIGHT: 'Lighting is too low. Move to a brighter area or face a light source.',
  FACE_QUALITY_TEXT_WATERMARK:
    'Text or watermark detected on the image. Please use an unedited photo.',
  FACE_QUALITY_BORDERS_DETECTED:
    'Image borders or frames detected. Use a full-frame photo without added borders.',
  FACE_QUALITY_MONOCHROME: 'Black and white photos are not accepted. Please use a color photo.',
  FACE_QUALITY_PRINTED_PHOTO:
    'This appears to be a photo of a photo or screen. Please use a live capture.',
  FACE_QUALITY_INDECENT:
    'Image does not meet our content guidelines. Please use an appropriate photo.',
  FACE_QUALITY_GARISH:
    'Heavy filters or makeup obscure your natural face. Please retake without filters.',
  FACE_QUALITY_MINOR:
    'You must be at least 16 to register. Contact support if you believe this is an error.',
  FACE_QUALITY_CONFIDENCE_TOO_LOW:
    'Face image quality is too low. Please retake in better lighting with a clear view of your face.',
  FACE_QUALITY_CONTENT_POLICY: 'Image violates our content policy and cannot be accepted.',
  FACE_DUPLICATE_IDENTITY: 'This face is already registered to another account.',
  FACE_VALIDATION_FAILED: 'Face image validation failed. Please retake and try again.',
}

export const FACE_QUALITY_RECOMMENDATIONS: Partial<Record<FaceRegistrationErrorCode, string>> = {
  FACE_QUALITY_BLURRED: 'Retake the photo in natural light with focus on your face.',
  FACE_QUALITY_LOW_LIGHT: 'Face a window or lamp and avoid backlighting.',
  FACE_QUALITY_HALF_COVERED: 'Keep eyes, nose, and mouth fully visible.',
  FACE_QUALITY_MINOR: 'Parental consent may be required — contact support for assistance.',
  FACE_DUPLICATE_IDENTITY: 'Contact support if you believe this is an error.',
}
