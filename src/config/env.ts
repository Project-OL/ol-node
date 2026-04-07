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
    REDIS_TTL_ME: z.coerce.number().default(900),
    REDIS_TTL_PROFILE: z.coerce.number().default(3600),
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().default(3000),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN: z.string().default('8m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
    JWT_REFRESH_SECRET: z.string().min(32).optional(), // if not set, uses JWT_ACCESS_SECRET (not recommended for prod)
    /** HMAC key for device binding fingerprint. Min 32 chars. Required in production. */
    DEVICE_FINGERPRINT_SECRET: z.string().min(32).optional(),

    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional(),
    /** If set (non-empty), avatar URLs use https://{domain}/{key}; else S3 virtual-hosted URL. */
    CLOUDFRONT_DOMAIN: z.string().optional(),
    MAX_AVATAR_SIZE_BYTES: z.coerce.number().default(5_242_880),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    /** Web OAuth client ID (e.g. client_type 3 in google-services.json). Verifies Google Sign-In ID tokens when `iss` is accounts.google.com. */
    GOOGLE_OAUTH_WEB_CLIENT_ID: z.string().optional(),
    /** Android OAuth client ID (client_type 1). Add if ID tokens use this as `aud`. */
    GOOGLE_OAUTH_ANDROID_CLIENT_ID: z.string().optional(),
    /** iOS OAuth client ID (client_type 2). Add if the iOS app’s ID token uses this as `aud`. */
    GOOGLE_OAUTH_IOS_CLIENT_ID: z.string().optional(),

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

    // LiveKit
    LIVEKIT_URL: z.string().url().optional(),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),

    // Wallet / coins
    COIN_TOPUP_RATE_LIMIT_MAX: z.coerce.number().default(5),
    COIN_TOPUP_RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
    POINTS_WITHDRAW_MIN: z.coerce.bigint().default(6700n),
    POINTS_WITHDRAW_MAX_WEEKLY: z.coerce.bigint().default(1050000n),
    POINTS_TO_USD_RATE: z.coerce.number().default(210),

    /** 1 = 1 coin → 1 point (receiver); 0.5 = 2 coins → 1 point */
    GIFT_COIN_TO_POINT_RATE: z.coerce.number().positive().default(1),

    /** Comma-separated user UUIDs allowed to call gift/gallery admin APIs */
    ADMIN_USER_IDS: z
      .string()
      .optional()
      .transform((s) =>
        s
          ? s
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
      ),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === 'production' && !val.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET is required in production and must be different from JWT_ACCESS_SECRET',
      })
    }
    if (val.NODE_ENV === 'production' && !val.DEVICE_FINGERPRINT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEVICE_FINGERPRINT_SECRET'],
        message: 'DEVICE_FINGERPRINT_SECRET is required in production (min 32 chars)',
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
