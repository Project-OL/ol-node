import { AppError } from '../middlewares/errorHandler'

export type FeedCursor = { createdAt: string; postId: string }

export function encodeCursor(createdAt: Date, postId: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), postId })).toString(
    'base64url',
  )
}

export function decodeCursor(cursor: string): FeedCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<FeedCursor>
    if (!parsed.createdAt || !parsed.postId) {
      throw new Error('missing fields')
    }
    return { createdAt: parsed.createdAt, postId: parsed.postId }
  } catch {
    throw new AppError(400, 'Invalid cursor', 'INVALID_CURSOR')
  }
}
