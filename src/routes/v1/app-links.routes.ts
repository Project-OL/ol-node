import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { appDownloadConfigService } from '../../services/appDownloadConfig.service'

/**
 * Public (no auth) store links for the marketing site, offoolive.com.
 *
 * GET /v1/app-links                 → { ios, playStore, android }
 * GET /v1/app-links/android/latest  → 302 to the current APK (stable link for QR codes / sharing)
 */
export default async function appLinksRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply: FastifyReply) => {
    const config = await appDownloadConfigService.getPublicConfig()
    return reply.header('Cache-Control', 'public, max-age=60').send(config)
  })

  app.get('/android/latest', async (_request, reply: FastifyReply) => {
    const { android } = await appDownloadConfigService.getPublicConfig()
    if (!android) throw new AppError(404, 'No Android build is available yet', 'APK_NOT_AVAILABLE')
    return reply.header('Cache-Control', 'no-store').redirect(302, android.url)
  })
}
