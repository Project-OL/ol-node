import { z } from 'zod'

export const getDevicesSchema = z.object({
  sortBy: z.enum(['lastActive', 'loginTime', 'name']).default('lastActive'),
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
})

/** Path param: `device_registry.id` (UUID). Legacy alias `deviceId` accepted via query `?deviceId=` for the same UUID. */
export const revokeDeviceParamsSchema = z.object({
  registryId: z.string().uuid('Invalid registry id'),
})

export const flushDeviceSessionsSchema = z.object({
  deviceId: z.string().min(1).max(255),
  deviceName: z.string().min(1).max(255),
})

export type FlushDeviceSessionsBody = z.infer<typeof flushDeviceSessionsSchema>

export const logoutAllSchema = z.object({
  securityPassword: z.string().min(1, 'Security password required'),
})

export const renameDeviceSchema = z.object({
  deviceName: z.string().min(1, 'Device name required').max(50, 'Device name too long'),
})

export const renameDeviceParamsSchema = z.object({
  registryId: z.string().uuid('Invalid registry id'),
})

export type GetDevicesQuery = z.infer<typeof getDevicesSchema>
export type LogoutAllBody = z.infer<typeof logoutAllSchema>
export type RenameDeviceBody = z.infer<typeof renameDeviceSchema>
