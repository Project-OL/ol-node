import { z } from 'zod'
import * as dotenv from 'dotenv'

dotenv.config()

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    API_VERSION: z.string().default('v1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().url(),
    DATABASE_DIRECT_URL: z.string().url().optional(),
    DATABASE_READ_URL: z.string().url().optional(), // optional read replica for scaling reads
    DATABASE_POOL_MIN: z.coerce.number().default(2),
    DATABASE_POOL_MAX: z.coerce.number().default(20),

    REDIS_URL: z.string().url(),
    REDIS_READ_URL: z.string().url().optional(),
    REDIS_PASSWORD: z.string().optional(),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
    JWT_REFRESH_SECRET: z.string().min(32).optional(), // if not set, uses JWT_ACCESS_SECRET (not recommended for prod)

    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional(),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),

    ML_SERVICE_URL: z.string().default('http://localhost:8000'),
    ML_SERVICE_API_KEY: z.string().optional(),

    OTP_EXPIRES_IN_MINUTES: z.coerce.number().default(5),
    OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
    STATIC_OTP_DEV: z.string().length(5).optional(), // e.g. "22222" for dev; when set, OTP is fixed and hashed
    SMS_PROVIDER_API_KEY: z.string().optional(),

    ALLOWED_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) => value.split(',').map((v) => v.trim()).filter(Boolean)),

    RATE_LIMIT_MAX: z.coerce.number().default(100),
    RATE_LIMIT_TIME_WINDOW: z.coerce.number().default(60000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().default(5),
    AUTH_RATE_LIMIT_TIME_WINDOW: z.coerce.number().default(60000),

    SECURITY_PASSWORD_ENABLED: z.coerce.boolean().default(true),
    SECURITY_PASSWORD_FAILED_ATTEMPTS_LIMIT: z.coerce.number().default(3),
    SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES: z.coerce.number().default(60),
    SECURITY_PASSWORD_RESET_TOKEN_EXPIRY_SECONDS: z.coerce.number().default(600),

    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().default(1_048_576), // 1MB
    MAX_UPLOAD_SIZE_BYTES: z.coerce.number().default(10_485_760), // 10MB
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === 'production' && !val.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET is required in production and must be different from JWT_ACCESS_SECRET',
      })
    }
  })

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env
