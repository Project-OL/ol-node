import fs from 'fs'
import path from 'path'
import { createPrivateKey } from 'crypto'
import * as admin from 'firebase-admin'
import { getMessaging, type Messaging } from 'firebase-admin/messaging'
import { env } from './env'
import { AppError } from '../middlewares/errorHandler'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'firebase' })

type ServiceAccountFields = {
  projectId: string
  clientEmail: string
  privateKey: string
  source: 'file' | 'env'
}

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

function assertPrivateKeyCryptoValid(privateKey: string): void {
  const hasBegin = privateKey.includes('BEGIN PRIVATE KEY')
  const hasEnd = privateKey.includes('END PRIVATE KEY')
  if (!hasBegin || !hasEnd) {
    throw new AppError(
      503,
      'FIREBASE_PRIVATE_KEY is missing BEGIN/END PRIVATE KEY markers (often truncated or not the service-account PEM)',
      'FIREBASE_PRIVATE_KEY_INVALID',
    )
  }
  if (privateKey.length < 1200) {
    throw new AppError(
      503,
      `FIREBASE_PRIVATE_KEY looks truncated (length ${privateKey.length}). Prefer FIREBASE_SERVICE_ACCOUNT_PATH pointing at the firebase-adminsdk JSON.`,
      'FIREBASE_PRIVATE_KEY_INVALID',
    )
  }
  try {
    createPrivateKey(privateKey)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new AppError(
      503,
      `FIREBASE_PRIVATE_KEY is not a valid RSA PEM (${message}). Use FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/firebase-adminsdk.json instead of pasting the key into .env.`,
      'FIREBASE_PRIVATE_KEY_INVALID',
      { reason: message },
    )
  }
}

function loadServiceAccountFromFile(filePath: string): ServiceAccountFields {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    throw new AppError(
      503,
      `FIREBASE_SERVICE_ACCOUNT_PATH not found: ${resolved}`,
      'FIREBASE_NOT_CONFIGURED',
    )
  }
  let parsed: {
    project_id?: string
    client_email?: string
    private_key?: string
  }
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as typeof parsed
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new AppError(
      503,
      `FIREBASE_SERVICE_ACCOUNT_PATH is not valid JSON (${message})`,
      'FIREBASE_PRIVATE_KEY_INVALID',
      { reason: message },
    )
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new AppError(
      503,
      'FIREBASE_SERVICE_ACCOUNT_PATH JSON must include project_id, client_email, private_key',
      'FIREBASE_NOT_CONFIGURED',
    )
  }
  const privateKey = normalizeFirebasePrivateKey(parsed.private_key)
  assertPrivateKeyCryptoValid(privateKey)
  return {
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey,
    source: 'file',
  }
}

function loadServiceAccountFromEnv(): ServiceAccountFields {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new AppError(
      503,
      'Firebase not configured — set FIREBASE_SERVICE_ACCOUNT_PATH (recommended) or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY',
      'FIREBASE_NOT_CONFIGURED',
    )
  }
  const privateKey = normalizeFirebasePrivateKey(env.FIREBASE_PRIVATE_KEY)
  assertPrivateKeyCryptoValid(privateKey)
  return {
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey,
    source: 'env',
  }
}

function resolveServiceAccount(): ServiceAccountFields {
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim()) {
    return loadServiceAccountFromFile(env.FIREBASE_SERVICE_ACCOUNT_PATH.trim())
  }
  return loadServiceAccountFromEnv()
}

/** Shared Firebase Admin app instance — used for OAuth token verification and FCM push. */
export function getFirebaseApp(): admin.app.App {
  if (!admin.apps.length) {
    const sa = resolveServiceAccount()
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: sa.projectId,
          clientEmail: sa.clientEmail,
          privateKey: sa.privateKey,
        }),
        projectId: sa.projectId,
      })
      log.info(
        {
          projectId: sa.projectId,
          clientEmail: sa.clientEmail,
          privateKeyLength: sa.privateKey.length,
          source: sa.source,
        },
        'Firebase Admin initialized',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/asymmetric key|PEM|DECODER|private key|then/i.test(message)) {
        throw new AppError(
          503,
          `Firebase private key is invalid (${message}). Prefer FIREBASE_SERVICE_ACCOUNT_PATH to the firebase-adminsdk JSON file.`,
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
        'Firebase credential returned no access token — check FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_PRIVATE_KEY',
        'FIREBASE_PRIVATE_KEY_INVALID',
      )
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new AppError(
      503,
      `Firebase credential check failed (${message}). Use FIREBASE_SERVICE_ACCOUNT_PATH=/abs/path/to/firebase-adminsdk.json and restart PM2.`,
      'FIREBASE_PRIVATE_KEY_INVALID',
      { reason: message },
    )
  }
}
