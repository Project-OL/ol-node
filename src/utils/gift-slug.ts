/** Lowercase slug for gift codes and category slugs. */
export function toGiftSlug(input: string, maxLen = 64): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen)
  return slug.length > 0 ? slug : 'item'
}
