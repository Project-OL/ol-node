import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { userPaymentMethodService } from "../../services/userPaymentMethod.service";
import { rateLimitPmBind } from "../../middlewares/rateLimitAuth";
import { BindEpaySchema, BindBankSchema } from "../../models/paymentMethod.schemas";

export async function paymentMethodRoutes(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rows = await userPaymentMethodService.getMyMethods(request.userId!);
      return reply.send(rows);
    },
  );

  app.post(
    "/epay",
    { preHandler: [authenticate, rateLimitPmBind] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = BindEpaySchema.parse(request.body ?? {});
      const pwd =
        (request.headers["x-security-password"] as string | undefined)?.trim() ??
        "";
      if (!pwd) {
        throw new AppError(
          400,
          "X-Security-Password header required",
          "SECURITY_PASSWORD_REQUIRED",
        );
      }
      await userPaymentMethodService.bindEpay(request.userId!, body, pwd);
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/bank",
    { preHandler: [authenticate, rateLimitPmBind] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = BindBankSchema.parse(request.body ?? {});
      const pwd =
        (request.headers["x-security-password"] as string | undefined)?.trim() ??
        "";
      if (!pwd) {
        throw new AppError(
          400,
          "X-Security-Password header required",
          "SECURITY_PASSWORD_REQUIRED",
        );
      }
      await userPaymentMethodService.bindBank(request.userId!, body, pwd);
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: { methodType: string } }>(
    "/:methodType",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const mt = request.params.methodType.toUpperCase();
      if (mt !== "EPAY" && mt !== "BANK") {
        throw new AppError(400, "Invalid method type", "INVALID_REQUEST");
      }
      await userPaymentMethodService.unbind(request.userId!, mt as "EPAY" | "BANK");
      return reply.send({ ok: true });
    },
  );
}
