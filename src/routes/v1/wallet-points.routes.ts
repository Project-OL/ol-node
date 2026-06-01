import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../../middlewares/auth.middleware";
import { rateLimitWithdrawalCreate } from "../../middlewares/rateLimitAuth";
import { pointWalletService } from "../../services/point-wallet.service";
import { walletService } from "../../services/wallet.service";
import {
  WithdrawInitiateSchema,
  PointHistoryQuerySchema,
} from "../../models/wallet.schemas";

export async function walletPointsRoutes(app: FastifyInstance) {
  app.get(
    "/summary",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await pointWalletService.getSummary(request.userId!);
      return reply.send(result);
    },
  );

  app.get(
    "/balance",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const [total, unconfirmed] = await Promise.all([
        walletService.getPointBalance(userId),
        pointWalletService.getUnconfirmedPoints(userId),
      ]);
      const available = total - unconfirmed;
      return reply.send({
        // `balance` retained for backward compatibility (== totalPoints).
        balance: total.toString(),
        totalPoints: total.toString(),
        availablePoints: available.toString(),
        unconfirmedPoints: unconfirmed.toString(),
      });
    },
  );

  app.post(
    "/withdraw",
    { preHandler: [authenticate, rateLimitWithdrawalCreate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = WithdrawInitiateSchema.parse(request.body);
      const result = await pointWalletService.initiateWithdrawal(
        request.userId!,
        body.amountPoints,
        body.paymentMethodId,
        body.idempotencyKey,
        body.notes,
      );
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/history",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = PointHistoryQuerySchema.parse(request.query);
      const result = await pointWalletService.getHistory(request.userId!, {
        types: query.types,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );
}
