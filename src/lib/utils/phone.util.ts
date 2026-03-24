import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js'

export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s\-().]/g, '')
  if (!isValidPhoneNumber(cleaned)) return null
  return parsePhoneNumber(cleaned).number as string
}

export function formatPhoneForDisplay(e164: string): string {
  try {
    return parsePhoneNumber(e164).formatInternational()
  } catch {
    return e164
  }
}

export function getCountryFromPhone(e164: string): string | undefined {
  try {
    return parsePhoneNumber(e164).country
  } catch {
    return undefined
  }
}

export function isSamePhone(a: string, b: string): boolean {
  const normA = normalizePhone(a)
  const normB = normalizePhone(b)
  return !!normA && !!normB && normA === normB
}

