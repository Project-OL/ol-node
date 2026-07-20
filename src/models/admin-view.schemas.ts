import { z } from 'zod'

/** "METHOD /admin/path" — path relative to /api/{version}, `:param` segments allowed. */
export const AdminEndpointSchema = z
  .string()
  .trim()
  .regex(
    /^(GET|POST|PUT|PATCH|DELETE) \/admin(\/[A-Za-z0-9._:-]+)*$/,
    'Endpoint must look like "GET /admin/users/search" (method space /admin/... path)',
  )

export const ViewNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'View name must be alphanumeric (plus _ -)')

/** POST /admin/views — create a new view or extend an existing one (endpoint union). */
export const UpsertViewSchema = z.object({
  name: ViewNameSchema,
  endpoints: z.array(AdminEndpointSchema).max(200),
})

/** PUT /admin/views/:viewName — replace the endpoint list entirely. */
export const ReplaceViewEndpointsSchema = z.object({
  endpoints: z.array(AdminEndpointSchema).max(200),
})

export const ViewNameParamsSchema = z.object({
  viewName: ViewNameSchema,
})

/** PUT /admin/support/csas/:adminId/views — replace the CSA's assigned view set. */
export const AssignViewsSchema = z.object({
  views: z.array(ViewNameSchema).max(100),
})

export type UpsertViewInput = z.infer<typeof UpsertViewSchema>
export type AssignViewsInput = z.infer<typeof AssignViewsSchema>
