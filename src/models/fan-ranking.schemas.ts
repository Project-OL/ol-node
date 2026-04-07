import { z } from "zod";

export const FanRankingQuerySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("month"),
});
