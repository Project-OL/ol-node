export const ROYAL_HOST_TAG = 'royal host'

export function hasRoyalHostTag(adminTags: string[]): boolean {
  return adminTags.some((t) => t.trim().toLowerCase() === ROYAL_HOST_TAG)
}
