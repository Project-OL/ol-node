import * as admin from 'firebase-admin'
import { env } from './env'
import { AppError } from '../middlewares/errorHandler'

/** Shared Firebase Admin app instance — used for OAuth token verification and FCM push. */
export function getFirebaseApp(): admin.app.App {
  if (!admin.apps.length) {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
      throw new AppError(503, 'Firebase not configured', 'FIREBASE_NOT_CONFIGURED')
    }
    const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    })
  }
  return admin.app()
}
