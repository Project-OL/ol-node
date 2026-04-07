import { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env";
import { AppError } from "./errorHandler";
import { authenticate } from "./auth.middleware";

declare module "fastify" {
  interface FastifyRequest {
    isAdmin?: boolean;
  }
}

/**
 * After `authenticate`: allows only users listed in `ADMIN_USER_IDS` (env).
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticate(request, reply);
  const uid = request.userId;
  if (!uid) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  if (!env.ADMIN_USER_IDS.includes(uid)) {
    throw new AppError(403, "Admin only", "FORBIDDEN");
  }
  request.isAdmin = true;
}
