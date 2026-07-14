import { z } from 'zod'

export const OtpDeliveryConfigUpdateSchema = z.object({
  /** Window (seconds) during which per-phone OTP requests are counted for WhatsApp vs SMS routing. */
  smsTriggerIntervalSec: z.number().int().min(30).max(3600),
})
