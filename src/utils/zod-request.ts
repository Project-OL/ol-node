import type { z } from 'zod'
import { AppError } from '../middlewares/errorHandler'

/**
 * Parse a request payload against a zod schema, mapping validation failures
 * to 400 INVALID_REQUEST (same convention as report.routes) instead of the
 * unhandled-ZodError 500.
 */
export function parseRequest<T extends z.ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new AppError(
      400,
      parsed.error.errors[0]?.message ?? 'Invalid request',
      'INVALID_REQUEST',
      { issues: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })) },
    )
  }
  return parsed.data
}
