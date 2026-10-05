import { z } from 'zod'

/** Optional https link restricted to the given hosts; '' clears it (stored as null). */
function storeUrl(hosts: string[], label: string) {
  return z
    .union([z.literal(''), z.string().trim().url().max(500)])
    .nullable()
    .transform((v) => (v ? v : null))
    .refine(
      (v) => {
        if (v === null) return true
        const url = new URL(v)
        return url.protocol === 'https:' && hosts.includes(url.hostname)
      },
      { message: `${label} must be an https link on ${hosts.join(' or ')}` },
    )
}

export const AppLinksUpdateSchema = z.object({
  iosUrl: storeUrl(['apps.apple.com', 'testflight.apple.com'], 'iOS link'),
  playStoreUrl: storeUrl(['play.google.com'], 'Play Store link'),
})

/** Becomes part of the object key and the downloaded file name (offoolive-<version>.apk). */
export const ApkVersionNameSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/, 'Version may use letters, digits, . _ + - (max 40)')

export const ApkUploadUrlBodySchema = z.object({
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  versionName: ApkVersionNameSchema,
})

export const ApkReleaseCreateBodySchema = z.object({
  key: z.string().min(1).max(300),
  versionName: ApkVersionNameSchema,
})

export const ApkCurrentReleaseBodySchema = z.object({
  releaseId: z.string().uuid(),
})

export type AppLinksUpdateInput = z.infer<typeof AppLinksUpdateSchema>
export type ApkUploadUrlBody = z.infer<typeof ApkUploadUrlBodySchema>
export type ApkReleaseCreateBody = z.infer<typeof ApkReleaseCreateBodySchema>
