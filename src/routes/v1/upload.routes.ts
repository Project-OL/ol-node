import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { uploadService } from '../../services/upload.service'
import { authenticate } from '../../middlewares/auth.middleware'

const presignedUrlQuerySchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
})

export default async function uploadRoutes(app: FastifyInstance) {
  app.get(
    '/presigned-url',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = presignedUrlQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'contentType is required (image/jpeg, image/png, or image/webp)',
          details: parsed.error.flatten().fieldErrors,
        })
      }

      const userId = (request as { userId?: string }).userId
      if (!userId) {
        return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
      }
      const result = await uploadService.generatePresignedAvatarUrl(userId, parsed.data.contentType)
      return reply.send(result)
    },
  )
}
