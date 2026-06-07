import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from './errorHandler'
import { userRepository } from '../repositories/user.repository'

/** JWT + lightweight is_agent check (retries stale Neon connections). */
export async function requireAgent(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const userId = request.userId
  if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  const isAgent = await userRepository.isAgentUser(userId)
  if (!isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
}
