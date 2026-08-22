import { AppError } from '../middlewares/errorHandler'

export const RESTRICTED_NAME = 'RESTRICTED_NAME'
export const RESTRICTED_NAME_MESSAGE = 'This name contains a restricted word'

export const DEFAULT_RESTRICTED_IDENTITY_WORDS = ['admin', 'official', 'offoo', 'support'] as const

export function normalizeRestrictedWord(word: string): string {
  return word.trim().toLowerCase()
}

export function normalizeRestrictedWordList(words: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of words) {
    const w = normalizeRestrictedWord(raw)
    if (!w || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

/** Case-insensitive substring. Words are literals (not regex). */
export function containsRestrictedWord(text: string, words: readonly string[]): boolean {
  const hay = text.toLowerCase()
  if (!hay) return false
  for (const word of words) {
    if (word && hay.includes(word)) return true
  }
  return false
}

export function assertIdentityNotRestricted(
  text: string,
  words: readonly string[],
  opts?: { allowRestricted?: boolean },
): void {
  if (opts?.allowRestricted) return
  const value = text.trim()
  if (!value) return
  if (containsRestrictedWord(value, words)) {
    throw new AppError(400, RESTRICTED_NAME_MESSAGE, RESTRICTED_NAME)
  }
}
