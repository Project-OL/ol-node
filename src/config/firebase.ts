import * as admin from 'firebase-admin'
import { getMessaging, type Messaging } from 'firebase-admin/messaging'
import { env } from './env'
import { AppError } from '../middlewares/errorHandler'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'firebase' })

/**
 * Normalize a Firebase service-account private key from env.
 * Accepts PEM with real newlines, or a single-line value with `\n` escapes,
 * optionally wrapped in quotes (common when pasted into .env / PM2).
 */
export function normalizeFirebasePrivateKey(raw: string): string {
  let key = raw.trim()
  // Strip surrounding single/double quotes if the whole value was quoted in .env
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1)
  }
  // Handle double-escaped newlines from some process managers: \\n → \n → real newline
  key = key.replace(/\\\\n/g, '\\n').replace(/\\n/g, '\n')
  key = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  return key
}

function assertPrivateKeyLooksValid(privateKey: string): void {
  const hasBegin = privateKey.includes('BEGIN PRIVATE KEY')
  const hasEnd = privateKey.includes('END PRIVATE KEY')
  if (!hasBegin || !hasEnd) {
    throw new AppError(
      503,
      'FIREBASE_PRIVATE_KEY is missing BEGIN/END PRIVATE KEY markers (often truncated or not the service-account PEM)',
      'FIREBASE_PRIVATE_KEY_INVALID',
    )
  }
  // A real PKCS8 service-account key is typically >1600 chars once unescaped.
  if (privateKey.length < 1200) {
    throw new AppError(
      503,
      `FIREBASE_PRIVATE_KEY looks truncated (length ${privateKey.length}). Paste the full private_key from the firebase-adminsdk JSON.`,
      'FIREBASE_PRIVATE_KEY_INVALID',
    )
  }
}

/** Shared Firebase Admin app instance — used for OAuth token verification and FCM push. */
export function getFirebaseApp(): admin.app.App {
  if (!admin.apps.length) {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
      throw new AppError(503, 'Firebase not configured', 'FIREBASE_NOT_CONFIGURED')
    }
    const privateKey = normalizeFirebasePrivateKey(env.FIREBASE_PRIVATE_KEY)
    assertPrivateKeyLooksValid(privateKey)
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
        projectId: env.FIREBASE_PROJECT_ID,
      })
      log.info(
        {
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKeyLength: privateKey.length,
        },
        'Firebase Admin initialized',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Surface the common PEM / RS256 misconfig clearly instead of a vague FCM 502.
      if (/asymmetric key|PEM|DECODER|private key|then/i.test(message)) {
        throw new AppError(
          503,
          `Firebase private key is invalid (${message}). Re-copy private_key from offoolive-d3f9f-firebase-adminsdk-*.json into FIREBASE_PRIVATE_KEY (one quoted line with \\n), then pm2 restart ol-api --update-env.`,
          'FIREBASE_PRIVATE_KEY_INVALID',
          { reason: message },
        )
      }
      throw err
    }
  }
  return admin.app()
}

export function getFirebaseMessaging(): Messaging {
  return getMessaging(getFirebaseApp())
}

/**
 * Proves the service-account key can mint Google access tokens.
 * Call once before the first FCM send so config errors are not masked as PUSH_SEND_FAILED.
 */
export async function assertFirebaseCredentials(): Promise<void> {
  const app = getFirebaseApp()
  const credential = app.options.credential
  if (!credential || typeof credential.getAccessToken !== 'function') {
    throw new AppError(
      503,
      'Firebase credential is missing getAccessToken — FIREBASE_* env is incomplete',
      'FIREBASE_PRIVATE_KEY_INVALID',
    )
  }
  try {
    const token = await credential.getAccessToken()
    if (!token?.access_token) {
      throw new AppError(
        503,
        'Firebase credential returned no access token — check FIREBASE_PRIVATE_KEY / client email',
        'FIREBASE_PRIVATE_KEY_INVALID',
      )
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new AppError(
      503,
      `Firebase credential check failed (${message}). Fix FIREBASE_PRIVATE_KEY from the firebase-adminsdk JSON and restart with --update-env.`,
      'FIREBASE_PRIVATE_KEY_INVALID',
      { reason: message },
    )
  }
}
