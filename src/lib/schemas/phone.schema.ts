import { z } from 'zod'
import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js'

export const phoneSchema = z
  .string()
  .trim()
  .transform((val) => val.replace(/[\s\-().]/g, ''))
  .refine((val) => isValidPhoneNumber(val), {
    message: 'Invalid phone number. Use E.164 format e.g. +919876543210',
  })
  .transform((val) => parsePhoneNumber(val).number as string)
