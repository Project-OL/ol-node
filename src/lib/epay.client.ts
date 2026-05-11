import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { AppError } from "../middlewares/errorHandler";

type OrderType = "PERSONAL_TOPUP" | "TRADING_TOPUP";

const client = axios.create({
  baseURL: env.EPAY_BASE_URL,
  timeout: 15_000,
  headers: {
    Authorization: `Bearer ${env.EPAY_API_KEY}`,
    "Content-Type": "application/json",
  },
});

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status == null || status < 500 || attempt === retries) break;
      const delay = Math.pow(2, attempt) * 300;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new AppError(502, "Epay gateway error", "EPAY_GATEWAY_ERROR", {
    cause: String(lastErr),
  });
}

export const epayClient = {
  async createOrder(params: {
    amountUsd: number;
    currency: string;
    orderId: string;
    orderType: OrderType;
    description: string;
    callbackUrl: string;
    returnUrl: string;
  }): Promise<{ paymentUrl: string; gatewayRef: string }> {
    return withRetry(async () => {
      const { data } = await client.post("/api/orders", {
        amountUsd: params.amountUsd,
        currency: params.currency,
        orderId: params.orderId,
        orderType: params.orderType,
        description: params.description,
        callbackUrl: params.callbackUrl,
        returnUrl: params.returnUrl,
      });
      return { paymentUrl: data.paymentUrl, gatewayRef: data.gatewayRef };
    });
  },

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
    const digest = crypto
      .createHmac("sha256", env.EPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
    try {
      return crypto.timingSafeEqual(
        Buffer.from(digest, "utf8"),
        Buffer.from(signatureHeader, "utf8"),
      );
    } catch {
      return false;
    }
  },

  async verifyPayment(gatewayRef: string): Promise<{
    status: "COMPLETED" | "PENDING" | "FAILED";
    amountUsd: number;
  }> {
    return withRetry(async () => {
      const { data } = await client.get(`/api/orders/${gatewayRef}`);
      return { status: data.status, amountUsd: Number(data.amountUsd) };
    });
  },
};
