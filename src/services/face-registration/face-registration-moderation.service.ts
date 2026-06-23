import { env } from '../../config/env'
import { s3Bucket } from '../../config/s3'
import { detectModerationLabels, detectModerationLabelsFromS3 } from '../../lib/rekognition.client'
import { storageService } from '../storage.service'

export type ModerationLabelHit = { label: string; confidence: number }

const NUDITY_LABELS = new Set(['Explicit Nudity', 'Partial Nudity', 'Suggestive'])
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

/**
 * Reusable nudity / suggestive content check for registration, verification, and live-photo flows.
 */
export async function checkImageForNudity(
  s3Key: string,
  options?: { strictMode?: boolean },
): Promise<{
  isNudityDetected: boolean
  labels: ModerationLabelHit[]
  failureReason?: string
}> {
  if (!env.FACE_CONTENT_MODERATION_ENABLED) {
    return { isNudityDetected: false, labels: [] }
  }
  const strict = options?.strictMode ?? env.FACE_MODERATION_STRICT_MODE
  const res = await fetchModerationLabels(s3Key)
  const labels = mapLabels(res.ModerationLabels)
  const threshold = env.FACE_MODERATION_NUDITY_THRESHOLD
  const hits = labels.filter((l) => {
    if (!NUDITY_LABELS.has(l.label)) return false
    if (l.label === 'Partial Nudity' && !strict) return false
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

export async function checkContentPolicy(s3Key: string): Promise<{
  violated: boolean
  labels: ModerationLabelHit[]
  isViolenceOrWeapons: boolean
  isHateSymbols: boolean
}> {
  if (!env.FACE_CONTENT_MODERATION_ENABLED) {
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
