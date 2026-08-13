import { AppError } from '../middlewares/errorHandler'

export type SubscriptionCursor = { updatedAt: string; id: string }

export function encodeSubscriptionCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id })).toString(
    'base64url',
  )
}

export function decodeSubscriptionCursor(cursor: string): SubscriptionCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<SubscriptionCursor>
    if (!parsed.updatedAt || !parsed.id) {
      throw new Error('missing fields')
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id }
  } catch {
    throw new AppError(400, 'Invalid cursor', 'INVALID_CURSOR')
  }
}
