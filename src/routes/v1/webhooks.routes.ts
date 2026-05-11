import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../middlewares/errorHandler";
import { epayClient } from "../../lib/epay.client";
import { coinWalletService } from "../../services/coin-wallet.service";
import { coinTradingService } from "../../services/coinTrading.service";
import { enqueueWebhookRetry } from "../../queues/epay-webhook.queue";
import { prisma } from "../../config/database";

export async function webhooksRoutes(app: FastifyInstance) {
  app.post(
    "/epay",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = String(request.headers["x-epay-signature"] ?? "");
      const raw = Buffer.from(JSON.stringify(request.body ?? {}));
      if (!epayClient.verifyWebhookSignature(raw, signature)) {
        throw new AppError(401, "Invalid signature", "INVALID_WEBHOOK_SIGNATURE");
      }
      const payload = request.body as {
        orderType: "PERSONAL_TOPUP" | "TRADING_TOPUP";
        orderId: string;
        gatewayRef: string;
        amountUsd: number;
        userId?: string;
      };
      try {
        if (payload.orderType === "PERSONAL_TOPUP") {
          const order = await prisma.coinTopupOrder.findUnique({ where: { id: payload.orderId } });
          if (order?.userId) {
            await coinWalletService.confirmTopup(
              order.userId,
              payload.orderId,
              payload.gatewayRef,
              `epay-personal-topup:${payload.orderId}`,
            );
          }
        } else {
          const order = await prisma.coinTradingTopupOrder.findUnique({ where: { id: payload.orderId } });
          if (order) {
            await coinTradingService.confirmTopup(order, payload);
          }
        }
      } catch (_err) {
        await enqueueWebhookRetry(payload, payload.orderType);
      }
      return reply.send({ ok: true });
    },
  );
}
