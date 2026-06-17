import { z } from 'zod'

const adminTagSchema = z
  .string()
  .trim()
  .min(1, 'Tag cannot be empty')
  .max(50, 'Tag must be at most 50 characters')

export const adminUserTagsBodySchema = z.object({
  tags: z.array(adminTagSchema).max(20, 'At most 20 tags allowed'),
})

export type AdminUserTagsBody = z.infer<typeof adminUserTagsBodySchema>

/** Trim, drop empties, dedupe case-insensitively while preserving first occurrence order. */
export function normalizeAdminTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}
