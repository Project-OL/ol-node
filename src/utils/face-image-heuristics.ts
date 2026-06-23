import type { BoundingBox, FaceDetail, Landmark } from '@aws-sdk/client-rekognition'
import { decode as decodeJpeg } from 'jpeg-js'
import { env } from '../config/env'

const KEY_LANDMARK_TYPES = new Set(['eyeLeft', 'eyeRight', 'nose', 'mouthLeft', 'mouthRight'])

type RgbImage = { width: number; height: number; data: Uint8Array }

function tryDecodeImage(imageBytes: Uint8Array): RgbImage | null {
  try {
    if (imageBytes[0] === 0xff && imageBytes[1] === 0xd8) {
      const decoded = decodeJpeg(imageBytes, { useTArray: true, formatAsRGBA: true })
      return { width: decoded.width, height: decoded.height, data: decoded.data }
    }
  } catch {
    /* unsupported or corrupt */
  }
  return null
}

function rgbToHsl(r: number, g: number, b: number): { s: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { s: 0 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  return { s: s * 100 }
}

function sampleRegionSaturation(img: RgbImage, box: BoundingBox, samples = 120): number {
  const left = Math.max(0, Math.floor((box.Left ?? 0) * img.width))
  const top = Math.max(0, Math.floor((box.Top ?? 0) * img.height))
  const w = Math.max(1, Math.floor((box.Width ?? 0) * img.width))
  const h = Math.max(1, Math.floor((box.Height ?? 0) * img.height))
  let total = 0
  let count = 0
  for (let i = 0; i < samples; i += 1) {
    const x = left + Math.floor((i / samples) * w)
    const y = top + Math.floor(h / 2)
    const idx = (y * img.width + x) * 4
    if (idx + 2 >= img.data.length) continue
    const { s } = rgbToHsl(img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!)
    total += s
    count += 1
  }
  return count > 0 ? total / count : 0
}

function averageImageSaturation(img: RgbImage, step = 8): number {
  let total = 0
  let count = 0
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const idx = (y * img.width + x) * 4
      const { s } = rgbToHsl(img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!)
      total += s
      count += 1
    }
  }
  return count > 0 ? total / count : 0
}

function sampleEdgeBrightness(img: RgbImage, edge: 'top' | 'bottom' | 'left' | 'right'): number {
  const edgePx = Math.max(2, Math.floor(Math.min(img.width, img.height) * 0.02))
  const samples: number[] = []
  const push = (x: number, y: number) => {
    const idx = (y * img.width + x) * 4
    samples.push((img.data[idx]! + img.data[idx + 1]! + img.data[idx + 2]!) / 3)
  }
  if (edge === 'top' || edge === 'bottom') {
    const y = edge === 'top' ? 0 : img.height - edgePx
    for (let x = 0; x < img.width; x += Math.max(1, Math.floor(img.width / 30))) {
      for (let e = 0; e < edgePx; e += 1) push(x, y + e)
    }
  } else {
    const x = edge === 'left' ? 0 : img.width - edgePx
    for (let y = 0; y < img.height; y += Math.max(1, Math.floor(img.height / 30))) {
      for (let e = 0; e < edgePx; e += 1) push(x + e, y)
    }
  }
  if (!samples.length) return 128
  return samples.reduce((a, b) => a + b, 0) / samples.length
}

function isUniformEdge(img: RgbImage, edge: 'top' | 'bottom' | 'left' | 'right'): boolean {
  const edgePx = Math.max(2, Math.floor(Math.min(img.width, img.height) * 0.02))
  const colors: number[][] = []
  const push = (x: number, y: number) => {
    const idx = (y * img.width + x) * 4
    colors.push([img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!])
  }
  if (edge === 'top' || edge === 'bottom') {
    const y = edge === 'top' ? 0 : img.height - edgePx
    for (let x = 0; x < img.width; x += Math.max(1, Math.floor(img.width / 30))) {
      for (let e = 0; e < edgePx; e += 1) push(x, y + e)
    }
  } else {
    const x = edge === 'left' ? 0 : img.width - edgePx
    for (let y = 0; y < img.height; y += Math.max(1, Math.floor(img.height / 30))) {
      for (let e = 0; e < edgePx; e += 1) push(x + e, y)
    }
  }
  if (colors.length < 6) return false
  const avg = colors.reduce((acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b], [0, 0, 0])
  const n = colors.length
  const mr = avg[0]! / n
  const mg = avg[1]! / n
  const mb = avg[2]! / n
  const variance =
    colors.reduce((sum, [r, g, b]) => sum + (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2, 0) / n
  const avgBright = sampleEdgeBrightness(img, edge)
  const isNeutral = Math.abs(mr - mg) < 18 && Math.abs(mg - mb) < 18
  const isWhiteOrBlack = avgBright > 225 || avgBright < 30
  return isNeutral && isWhiteOrBlack && variance < 500
}

function borderEdgeCount(img: RgbImage): number {
  const edges: Array<'top' | 'bottom' | 'left' | 'right'> = ['top', 'bottom', 'left', 'right']
  return edges.filter((e) => isUniformEdge(img, e)).length
}

function detectPrintedPhotoTexture(img: RgbImage): boolean {
  const edgePx = Math.max(3, Math.floor(Math.min(img.width, img.height) * 0.03))
  let edgeGrad = 0
  let centerGrad = 0
  let edgeN = 0
  let centerN = 0
  const gradAt = (x: number, y: number) => {
    const idx = (y * img.width + x) * 4
    const idxR = (y * img.width + Math.min(img.width - 1, x + 1)) * 4
    const lum = (img.data[idx]! + img.data[idx + 1]! + img.data[idx + 2]!) / 3
    const lumR = (img.data[idxR]! + img.data[idxR + 1]! + img.data[idxR + 2]!) / 3
    return Math.abs(lum - lumR)
  }
  for (let x = 1; x < img.width - 1; x += 4) {
    for (let y = 1; y < edgePx; y += 2) {
      edgeGrad += gradAt(x, y)
      edgeN += 1
    }
  }
  const cx = Math.floor(img.width / 2)
  const cy = Math.floor(img.height / 2)
  for (let dx = -20; dx <= 20; dx += 4) {
    for (let dy = -20; dy <= 20; dy += 4) {
      const x = cx + dx
      const y = cy + dy
      if (x <= 0 || y <= 0 || x >= img.width - 1 || y >= img.height - 1) continue
      centerGrad += gradAt(x, y)
      centerN += 1
    }
  }
  const edgeAvg = edgeN > 0 ? edgeGrad / edgeN : 0
  const centerAvg = centerN > 0 ? centerGrad / centerN : 0
  return edgeAvg > centerAvg * 2.2 && edgeAvg > 12
}

export function countMissingKeyLandmarks(landmarks: Landmark[] | undefined): number {
  if (!landmarks?.length) return KEY_LANDMARK_TYPES.size
  let missing = 0
  for (const type of KEY_LANDMARK_TYPES) {
    const found = landmarks.find((l) => l.Type?.toLowerCase() === type.toLowerCase())
    if (!found) {
      missing += 1
    }
  }
  return missing
}

export function analyzeImageHeuristics(
  imageBytes: Uint8Array,
  face: FaceDetail,
): {
  isMonochrome: boolean
  hasBorders: boolean
  isPrintedPhoto: boolean
  faceSaturation: number | null
  avgSaturation: number | null
} {
  const img = tryDecodeImage(imageBytes)
  if (!img) {
    return {
      isMonochrome: false,
      hasBorders: false,
      isPrintedPhoto: false,
      faceSaturation: null,
      avgSaturation: null,
    }
  }
  const box = face.BoundingBox ?? {}
  const faceSaturation = sampleRegionSaturation(img, box)
  const avgSaturation = averageImageSaturation(img)
  const aspect = img.width / Math.max(1, img.height)
  const faceAspect = (box.Width ?? 0) / Math.max(0.01, box.Height ?? 0.5)
  const aspectMismatch = Math.abs(aspect - 1) < 0.05 && Math.abs(faceAspect - 1) > 0.35
  const borderEdges = borderEdgeCount(img)
  return {
    isMonochrome: avgSaturation < env.FACE_MONOCHROME_SATURATION_MAX,
    hasBorders: borderEdges >= 2 || aspectMismatch,
    isPrintedPhoto: detectPrintedPhotoTexture(img),
    faceSaturation,
    avgSaturation,
  }
}

export function normalizeRekognitionMetric(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return 0
  return Math.round(Math.min(100, Math.max(0, value)))
}
