import { MESSAGING_AUDIO_MAX_WAVEFORM_BARS } from './message-audio.constants'

export type WaveformJsonV1 = { v: 1; e: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Encode normalized peaks in [0,1] to compact base64 u8 payload for DB + WS. */
export function encodeWaveformPeaksNormalized(peaks: number[]): WaveformJsonV1 {
  const capped = peaks.slice(0, MESSAGING_AUDIO_MAX_WAVEFORM_BARS)
  const u8 = new Uint8Array(capped.length)
  for (let i = 0; i < capped.length; i++) {
    const x = Math.max(0, Math.min(1, capped[i]!))
    u8[i] = Math.round(x * 255)
  }
  return { v: 1, e: Buffer.from(u8).toString('base64') }
}

export function decodeWaveformPeaksNormalized(w: unknown): number[] | null {
  if (!isRecord(w)) return null
  if (w.v === 1 && typeof w.e === 'string') {
    try {
      const buf = Buffer.from(w.e, 'base64')
      const out: number[] = []
      for (let i = 0; i < buf.length; i++) {
        out.push(buf[i]! / 255)
      }
      return out
    } catch {
      return null
    }
  }
  if (Array.isArray(w.peaks)) {
    const arr = w.peaks.filter((n) => typeof n === 'number') as number[]
    if (arr.length > MESSAGING_AUDIO_MAX_WAVEFORM_BARS) return null
    if (arr.some((n) => n < 0 || n > 1)) return null
    return arr
  }
  return null
}

/** Validate client-supplied normalized peaks before persistence. */
export function assertValidWaveformPeaksNormalized(peaks: number[]): void {
  if (peaks.length === 0 || peaks.length > MESSAGING_AUDIO_MAX_WAVEFORM_BARS) {
    throw new RangeError('waveform length')
  }
  for (const p of peaks) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError('waveform value')
    }
  }
}
