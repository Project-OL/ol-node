import { env } from '../../config/env'
import { s3Bucket } from '../../config/s3'
import { detectModerationLabels, detectModerationLabelsFromS3 } from '../../lib/rekognition.client'
import { storageService } from '../storage.service'

export type ModerationLabelHit = { label: string; confidence: number }

export type NudityCheckResult = {
  isNudityDetected: boolean
  labels: ModerationLabelHit[]
  failureReason?: string
}

/** Parent + current AWS Rekognition moderation taxonomy. */
const NUDITY_LABELS = new Set([
  'Explicit Nudity',
  'Explicit',
  'Partial Nudity',
  'Non-Explicit Nudity',
  'Suggestive',
])
const PARTIAL_NUDITY_LABELS = new Set(['Partial Nudity', 'Non-Explicit Nudity'])
const CONTENT_POLICY_LABELS = new Set(['Violence', 'Weapons', 'Hate Symbols'])

async function loadImageBytes(s3Key: string): Promise<Uint8Array> {
  const buf = await storageService.getObjectBuffer(s3Key)
  return new Uint8Array(buf)
}

async function fetchModerationLabels(s3Key: string) {
  const bucket = s3Bucket?.trim()
  if (bucket) {
    try {
      return await detectModerationLabelsFromS3(bucket, s3Key)
    } catch {
      /* fall through to bytes */
    }
  }
  const bytes = await loadImageBytes(s3Key)
  return detectModerationLabels(bytes)
}

function mapLabels(
  labels: { Name?: string; Confidence?: number; ParentName?: string }[] | undefined,
): ModerationLabelHit[] {
  return (labels ?? [])
    .filter((l) => l.Name && l.Confidence != null)
    .map((l) => ({ label: l.Name!, confidence: Number(l.Confidence) }))
}

/** Pure label evaluation — unit-tested without Rekognition. */
export function evaluateNudityLabels(
  labels: ModerationLabelHit[],
  options?: { strictMode?: boolean; threshold?: number },
): NudityCheckResult {
  const strict = options?.strictMode ?? env.FACE_MODERATION_STRICT_MODE
  const threshold = options?.threshold ?? env.FACE_MODERATION_NUDITY_THRESHOLD
  const hits = labels.filter((l) => {
    if (!NUDITY_LABELS.has(l.label)) return false
    if (PARTIAL_NUDITY_LABELS.has(l.label) && !strict) return false
    return l.confidence >= threshold
  })
  if (hits.length > 0) {
    return {
      isNudityDetected: true,
      labels: hits,
      failureReason: hits.map((h) => h.label).join(', '),
    }
  }
  return { isNudityDetected: false, labels }
}

function shouldSkipModeration(forceEnabled?: boolean): boolean {
  return !forceEnabled && !env.FACE_CONTENT_MODERATION_ENABLED
}

/**
 * Reusable nudity / suggestive content check for registration, verification, live-photo, and avatar flows.
 * Pass `forceEnabled: true` for callers with their own feature flag (e.g. live photo, avatar).
 */
export async function checkImageForNudity(
  s3Key: string,
  options?: { strictMode?: boolean; forceEnabled?: boolean },
): Promise<NudityCheckResult> {
  if (shouldSkipModeration(options?.forceEnabled)) {
    return { isNudityDetected: false, labels: [] }
  }
  const res = await fetchModerationLabels(s3Key)
  return evaluateNudityLabels(mapLabels(res.ModerationLabels), {
    strictMode: options?.strictMode,
  })
}

/** Same check against in-memory image bytes (PATCH /users/me avatar, before S3 put). */
export async function checkImageBytesForNudity(
  imageBytes: Uint8Array,
  options?: { strictMode?: boolean; forceEnabled?: boolean },
): Promise<NudityCheckResult> {
  if (shouldSkipModeration(options?.forceEnabled)) {
    return { isNudityDetected: false, labels: [] }
  }
  const res = await detectModerationLabels(imageBytes)
  return evaluateNudityLabels(mapLabels(res.ModerationLabels), {
    strictMode: options?.strictMode,
  })
}

export async function checkContentPolicy(
  s3Key: string,
  options?: { forceEnabled?: boolean },
): Promise<{
  violated: boolean
  labels: ModerationLabelHit[]
  isViolenceOrWeapons: boolean
  isHateSymbols: boolean
}> {
  if (!options?.forceEnabled && !env.FACE_CONTENT_MODERATION_ENABLED) {
    return { violated: false, labels: [], isViolenceOrWeapons: false, isHateSymbols: false }
  }
  const res = await fetchModerationLabels(s3Key)
  const labels = mapLabels(res.ModerationLabels)
  const policyHits = labels.filter(
    (l) =>
      CONTENT_POLICY_LABELS.has(l.label) ||
      l.label.includes('Violence') ||
      l.label.includes('Weapon') ||
      l.label.includes('Hate'),
  )
  const isHateSymbols = policyHits.some((l) => l.label.includes('Hate'))
  const isViolenceOrWeapons = policyHits.some(
    (l) => l.label.includes('Violence') || l.label.includes('Weapon'),
  )
  return {
    violated: policyHits.length > 0,
    labels: policyHits,
    isViolenceOrWeapons,
    isHateSymbols,
  }
}

export async function detectTextOrWatermark(s3Key: string): Promise<boolean> {
  if (!env.FACE_CONTENT_MODERATION_ENABLED) return false
  const res = await fetchModerationLabels(s3Key)
  const labels = mapLabels(res.ModerationLabels)
  return labels.some(
    (l) =>
      l.label === 'Text' ||
      l.label.includes('Text') ||
      l.label.includes('Watermark') ||
      l.label.includes('Logo'),
  )
}

export function getFullModerationLabels(
  labels: { Name?: string; Confidence?: number; ParentName?: string }[] | undefined,
): ModerationLabelHit[] {
  return mapLabels(labels)
}
