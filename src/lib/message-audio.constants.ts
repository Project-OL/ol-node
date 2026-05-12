/** Central limits and MIME/extension policy for DM audio uploads + send validation. */

export const MESSAGING_AUDIO_MAX_DURATION_SEC = 3_600 // 1 hour cap (tune via env in messaging.service if needed)
export const MESSAGING_AUDIO_MAX_WAVEFORM_BARS = 200
export const MESSAGING_AUDIO_WAV_MAX_BYTES = 10 * 1024 * 1024 // WAV can blow up size — tighter cap

export const AUDIO_CODEC_VALUES = ['aac', 'mp3', 'opus', 'pcm_s16le', 'unknown'] as const
export type AudioCodecValue = (typeof AUDIO_CODEC_VALUES)[number]

/** Declared MIME → allowed file extensions (lowercase, no dot). Server chooses extension from MIME, not client filename. */
export const AUDIO_MIME_TO_EXTS: Record<string, readonly string[]> = {
  'audio/mpeg': ['mp3', 'mpeg', 'mpga'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/aac': ['aac', 'm4a'],
  'audio/x-m4a': ['m4a'],
  'audio/ogg': ['ogg', 'oga', 'opus'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/wave': ['wav'],
}

export const AUDIO_ALLOWED_MIMES = Object.keys(AUDIO_MIME_TO_EXTS) as readonly string[]

export function normalizeAudioMime(mime: string): string {
  return mime.trim().toLowerCase().split(';')[0]!.trim()
}

export function audioExtensionForMime(mime: string): string {
  const n = normalizeAudioMime(mime)
  const exts = AUDIO_MIME_TO_EXTS[n]
  if (!exts?.length) return 'bin'
  return exts[0]!
}

export function isMimeAllowedForAudio(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIO_MIME_TO_EXTS, normalizeAudioMime(mime))
}

export function extensionMatchesAudioMime(mime: string, extLower: string): boolean {
  const n = normalizeAudioMime(mime)
  const exts = AUDIO_MIME_TO_EXTS[n]
  if (!exts) return false
  return (exts as readonly string[]).includes(extLower)
}

/** Infer MIME from object key extension when client omits `mimeType` (must match allowed audio set). */
export function guessAudioMimeFromKey(key: string): string | undefined {
  const ext = key.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4'
  if (ext === 'mp3' || ext === 'mpeg' || ext === 'mpga') return 'audio/mpeg'
  if (ext === 'aac') return 'audio/aac'
  if (ext === 'ogg' || ext === 'oga' || ext === 'opus') return 'audio/ogg'
  if (ext === 'wav') return 'audio/wav'
  return undefined
}
