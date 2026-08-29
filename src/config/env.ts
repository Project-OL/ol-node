import { z } from 'zod'
import * as dotenv from 'dotenv'

dotenv.config()

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    /** Dedicated WS process (`src/ws-server.ts`). */
    WS_PORT: z.coerce.number().default(3001),
    /**
     * When `true` / `1`, the API process also registers GET /ws (single-process
     * dev/small-deploy mode). Default is `false` — production should run the
     * dedicated `npm run dev:ws` / `start:ws` process and route `/ws` to
     * `WS_PORT`, so an API pod started without this explicitly set never
     * silently double-runs the WS gateway alongside a dedicated ws-server.
     */
    WS_EMBED_IN_API: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    /** `all` = one process (default). Split with `worker:realtime` + `worker:general`. */
    WORKER_QUEUES: z.enum(['all', 'general', 'realtime']).default('all'),
    API_VERSION: z.string().default('v1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().url(),
    DATABASE_DIRECT_URL: z.string().url().optional(),
    DATABASE_READ_URL: z.string().url().optional(), // optional read replica for scaling reads
    DATABASE_POOL_MIN: z.coerce.number().default(2),
    /** Applied as Prisma `connection_limit` when the URL does not already set one. */
    DATABASE_POOL_MAX: z.coerce.number().default(20),

    REDIS_URL: z.string().url(),
    REDIS_READ_URL: z.string().url().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TTL_ME: z.coerce.number().default(900),
    /** Short assembled GET /users/me blob (profile + enrichments). */
    REDIS_TTL_ME_ASSEMBLED: z.coerce.number().int().min(5).max(120).default(20),
    /** Requester-independent GET /users/search card enrichments. */
    REDIS_TTL_USER_SEARCH_CARD: z.coerce.number().int().min(15).max(300).default(60),
    REDIS_TTL_PROFILE: z.coerce.number().default(3600),
    /**
     * Fraction of non-health requests logged at info (0–1).
     * `/health` is never logged. Set `< 1` in production to cut log CPU.
     */
    REQUEST_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().default(3000),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN: z.string().default('8m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
    JWT_REFRESH_SECRET: z.string().min(32).optional(), // if not set, uses JWT_ACCESS_SECRET (not recommended for prod)

    ADMIN_JWT_SECRET: z.string().min(32),
    ADMIN_JWT_REFRESH_SECRET: z.string().min(32),
    ADMIN_JWT_ACCESS_EXPIRES_IN: z.string().default('35m'),
    ADMIN_JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    ADMIN_INITIAL_EMAIL: z.string().email().optional(),
    ADMIN_INITIAL_PASSWORD: z.string().min(12).optional(),
    /**
     * When `true`, SUPER_ADMIN login also requires a matching row in
     * `admin_ip_whitelist` (empty list = blocked). CSA (`CUSTOMER_SUPPORT`)
     * whitelist is always enforced regardless of this flag.
     */
    SUPER_ADMIN_IP_WHITELIST_ENABLED: z
      .string()
      .optional()
      .transform((s) => s === 'true'),
    /** Optional override for inbox sender (`users.id`). When unset, server uses or creates `offoo_platform`. */
    PLATFORM_SENDER_USER_ID: z.string().uuid().optional(),
    /**
     * Agency user that receives BANK payroll takeover inventory (host payout + 60% fee reward).
     * Must be an existing `users.is_agent` row. Required to complete takeover payouts.
     */
    COMPANY_AGENCY_USER_ID: z.string().uuid().optional(),
    /** HMAC key for device binding fingerprint. Min 32 chars. Required in production. */
    DEVICE_FINGERPRINT_SECRET: z.string().min(32).optional(),

    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().default('ap-south-1'),
    AWS_S3_BUCKET: z.string().optional(),
    REKOGNITION_COLLECTION_ID: z.string().min(3),
    REKOGNITION_QUALITY_FILTER: z.enum(['NONE', 'AUTO', 'LOW', 'MEDIUM', 'HIGH']).default('AUTO'),
    FACE_MATCH_THRESHOLD_PASS: z.coerce.number().min(50).max(100).default(90),
    FACE_MATCH_THRESHOLD_REJECT: z.coerce.number().min(0).max(100).default(70),
    FACE_MIN_DETECT_CONFIDENCE: z.coerce.number().min(0).max(100).default(98),
    FACE_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
    FACE_INDEX_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    /**
     * Seed / fallback: block legacy `POST /face-verification/register` when true.
     * Runtime value is admin-toggleable via `face_liveness_config` (seeded from this on first create).
     */
    FACE_LIVENESS_REQUIRED: z.coerce.boolean().default(false),
    /**
     * Seed / fallback: require mintable STS creds on `POST /face-registration/session`.
     * Runtime value is admin-toggleable via `face_liveness_config`.
     */
    FACE_LIVENESS_CREDENTIALS_REQUIRED: z.coerce.boolean().default(false),
    FACE_REGISTER_RATE_PER_HOUR: z.coerce.number().int().positive().default(5),
    FACE_VERIFY_RATE_PER_HOUR: z.coerce.number().int().positive().default(10),
    /**
     * When true, skip all face register/verify/liveness rate limits (1h window + IP caps).
     * **ol-dev testing only** — must be false (or unset) in production. See CURRENT_CONTEXT go-live note.
     */
    FACE_RATE_LIMIT_DISABLED: z.coerce.boolean().default(false),
    /** `worker-face-index` sleep between Postgres polls (ms). */
    FACE_INDEX_POLL_MS: z.coerce.number().int().positive().default(2000),
    /** Max `PENDING_INDEX` rows processed per poll cycle (capped at 50 in job). */
    FACE_INDEX_BATCH: z.coerce.number().int().positive().default(5),

    /** Face Liveness + registration session TTL (minutes). */
    FACE_REGISTRATION_SESSION_TTL_MIN: z.coerce.number().int().positive().default(15),
    /** Minimum Rekognition Face Liveness confidence (0–100) before accepting reference image. */
    FACE_LIVENESS_CONFIDENCE_MIN: z.coerce.number().min(0).max(100).default(90),
    /** Risk score above this tightens liveness threshold by `FACE_LIVENESS_RISK_CONFIDENCE_DELTA`. */
    FACE_REGISTRATION_RISK_SCORE_STRICT: z.coerce.number().min(0).max(100).default(40),
    FACE_LIVENESS_RISK_CONFIDENCE_DELTA: z.coerce.number().min(0).max(30).default(5),
    FACE_REGISTRATION_RATE_SESSION_PER_HOUR: z.coerce.number().int().positive().default(10),
    FACE_REGISTRATION_RATE_VERIFY_PER_HOUR: z.coerce.number().int().positive().default(20),
    FACE_REGISTRATION_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    /** When true, `POST …/verify` requires supplemental video uploaded first. */
    FACE_REGISTRATION_SUPPLEMENTAL_VIDEO_REQUIRED: z.coerce.boolean().default(false),
    FACE_REGISTRATION_VIDEO_MAX_BYTES: z.coerce.number().int().positive().default(40_000_000),
    FACE_REGISTRATION_VIDEO_MIN_SEC: z.coerce.number().positive().default(3),
    FACE_REGISTRATION_VIDEO_MAX_SEC: z.coerce.number().positive().default(8),
    /** Audit images returned by GetFaceLivenessSessionResults (0–4). */
    FACE_LIVENESS_AUDIT_IMAGES_LIMIT: z.coerce.number().int().min(0).max(4).default(2),
    /** S3 prefix for Rekognition Face Liveness OutputConfig (reference + audit images). */
    FACE_LIVENESS_S3_OUTPUT_PREFIX: z.string().default('face-liveness'),
    /**
     * IAM role ARN for Amplify Face Liveness temporary credentials (AssumeRole).
     * Role must allow rekognition:StartFaceLivenessSession. When unset, session
     * response omits `credentials` and the client must supply its own AWS auth.
     */
    FACE_LIVENESS_STS_ROLE_ARN: z.string().optional(),
    /** STS session duration for Face Liveness client credentials (seconds). */
    FACE_LIVENESS_CREDENTIALS_DURATION_SEC: z.coerce.number().int().min(900).max(3600).default(900),

    /** Rekognition DetectFaces quality thresholds (0–100 scale). */
    FACE_MIN_BRIGHTNESS: z.coerce.number().min(0).max(100).default(30),
    FACE_MIN_SHARPNESS: z.coerce.number().min(0).max(100).default(30),
    /** Missing key landmark count before half-covered rejection. */
    FACE_MAX_LANDMARKS_MISSING: z.coerce.number().int().min(0).max(10).default(2),
    /** Landmark confidence floor (0–100). */
    FACE_LANDMARK_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(85),
    /** DetectModerationLabels nudity confidence % to reject. */
    FACE_MODERATION_NUDITY_THRESHOLD: z.coerce.number().min(0).max(100).default(50),
    /** When true, reject PARTIAL_NUDITY; else only EXPLICIT_NUDITY. */
    FACE_MODERATION_STRICT_MODE: z.coerce.boolean().default(false),
    FACE_MIN_USER_AGE: z.coerce.number().int().min(0).max(120).default(16),
    FACE_CHECK_MINOR_AGE: z.coerce.boolean().default(true),
    FACE_GENDER_AUTO_UPDATE_ENABLED: z.coerce.boolean().default(false),
    FACE_DUPLICATE_CHECK_ENABLED: z.coerce.boolean().default(true),
    FACE_CONTENT_MODERATION_ENABLED: z.coerce.boolean().default(false),
    /**
     * Live-photo verify worker: DetectModerationLabels (nudity + content policy).
     * Independent of face-registration; also honored when FACE_CONTENT_MODERATION_ENABLED is true.
     */
    LIVE_PHOTO_CONTENT_MODERATION_ENABLED: z.coerce.boolean().default(true),
    /**
     * Profile DP (complete-profile avatarUrl + PATCH /users/me avatar): DetectModerationLabels.
     * Independent of face-registration; also honored when FACE_CONTENT_MODERATION_ENABLED is true.
     * String transform so `false` in .env actually disables (z.coerce.boolean treats "false" as true).
     */
    AVATAR_CONTENT_MODERATION_ENABLED: z
      .string()
      .default('true')
      .transform((s) => s === 'true' || s === '1'),
    /** HSL saturation in face region above this → garish makeup heuristic. */
    FACE_GARISH_SATURATION_MAX: z.coerce.number().min(0).max(100).default(85),
    /** Image histogram avg saturation below this → monochrome. */
    FACE_MONOCHROME_SATURATION_MAX: z.coerce.number().min(0).max(100).default(10),

    LIVE_PHOTO_MATCH_THRESHOLD: z.coerce.number().min(50).max(100).default(95),
    LIVE_PHOTO_MIN_FACE_AREA: z.coerce.number().min(0.0001).max(1).default(0.004),
    LIVE_PHOTO_UPLOAD_URL_EXPIRES_SEC: z.coerce.number().int().positive().default(900),
    LIVE_PHOTO_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(7_340_032),
    LIVE_PHOTO_UPLOAD_URL_RATE_PER_HOUR: z.coerce.number().int().positive().default(30),
    LIVE_PHOTO_VERIFY_RATE_PER_HOUR: z.coerce.number().int().positive().default(20),
    LIVE_PHOTO_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
    LIVE_PHOTO_PROFILE_CACHE_TTL_SEC: z.coerce.number().int().positive().default(45),
    LIVE_PHOTO_VERIFY_STATUS_CACHE_TTL_SEC: z.coerce.number().int().positive().default(30),
    LIVE_PHOTO_VERIFY_LOCK_TTL_SEC: z.coerce.number().int().positive().default(180),

    /** If set (non-empty), avatar URLs use https://{domain}/{key}; else S3 virtual-hosted URL. */
    CLOUDFRONT_DOMAIN: z.string().optional(),
    MAX_AVATAR_SIZE_BYTES: z.coerce.number().default(5_242_880),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    /**
     * Preferred: absolute path to the firebase-adminsdk JSON on disk.
     * Avoids .env PEM escaping issues (RS256 "asymmetric key" errors).
     * When set, PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY are optional.
     */
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1).optional(),
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
    OTP_DELIVERY_ENABLED: z.coerce.boolean().default(false),
    /** When false (default), a failed WhatsApp OTP send does not retry via SMS. Threshold-based direct SMS is unaffected. */
    OTP_WHATSAPP_SMS_FALLBACK_ENABLED: z.coerce.boolean().default(false),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_SMS_TEMPLATE_ID: z.string().optional(),
    MSG91_WHATSAPP_TEMPLATE_ID: z.string().optional(),
    MSG91_WHATSAPP_SENDER: z.string().optional(),
    MSG91_WHATSAPP_NAMESPACE: z.string().optional(),
    MSG91_WHATSAPP_LANGUAGE_CODE: z.string().default('en'),
    MSG91_SENDER_ID: z.string().optional(),
    MSG91_DLT_ENTITY_ID: z.string().optional(),
    /** MSG91 WhatsApp template for the 30-minute pre-deletion notice (body_1 = deletion time). */
    MSG91_WHATSAPP_ACCOUNT_DELETION_TEMPLATE_ID: z.string().optional(),
    /** MSG91 SMS flow template for the 30-minute pre-deletion notice (`var` = deletion time). */
    MSG91_SMS_ACCOUNT_DELETION_TEMPLATE_ID: z.string().optional(),
    SES_FROM_EMAIL: z.string().email().optional(),
    SES_ACCESS_KEY_ID: z.string().optional(),
    SES_SECRET_ACCESS_KEY: z.string().optional(),
    /**
     * Configured OTP delivery cost snapshot (minor units, e.g. paise for INR).
     * Captured onto each otp_delivery_audits row at send time for historical accuracy.
     */
    OTP_COST_CURRENCY: z.string().length(3).default('INR'),
    OTP_COST_EMAIL_MINOR: z.coerce.number().int().min(0).default(2),
    OTP_COST_WHATSAPP_MINOR: z.coerce.number().int().min(0).default(25),
    OTP_COST_SMS_MINOR: z.coerce.number().int().min(0).default(15),

    ALLOWED_ORIGINS: z
      .string()
      .default('http://localhost:3000,http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      ),

    RATE_LIMIT_MAX: z.coerce.number().default(200),
    RATE_LIMIT_TIME_WINDOW: z.coerce.number().default(60000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().default(5),
    AUTH_RATE_LIMIT_TIME_WINDOW: z.coerce.number().default(60000),

    SECURITY_PASSWORD_ENABLED: z.coerce.boolean().default(true),
    SECURITY_PASSWORD_FAILED_ATTEMPTS_LIMIT: z.coerce.number().default(6),
    SECURITY_PASSWORD_LOCKOUT_DURATION_MINUTES: z.coerce.number().default(10),
    SECURITY_PASSWORD_RESET_TOKEN_EXPIRY_SECONDS: z.coerce.number().default(600),

    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().default(1_048_576), // 1MB
    MAX_UPLOAD_SIZE_BYTES: z.coerce.number().default(10_485_760), // 10MB

    /** Max UTF-8 bytes for one inbound WebSocket text frame (Phase 4). */
    WS_MAX_INCOMING_BYTES: z.coerce.number().default(65_536),
    /** Max validated JSON client frames per rolling 1s window per socket (Phase 4). */
    WS_MAX_CLIENT_FRAMES_PER_SEC: z.coerce.number().default(80),
    /** Close socket if no inbound message for this long (ms); any frame counts (Phase 4). */
    WS_IDLE_TIMEOUT_MS: z.coerce.number().default(180_000),
    /** Max JOINed conversation channels per socket (Phase 4). */
    WS_MAX_CONV_JOINS_PER_SOCKET: z.coerce.number().default(200),
    /** Max JOIN_PRESENCE / JOIN_GUARDIAN targets per socket. */
    WS_MAX_PRESENCE_JOINS_PER_SOCKET: z.coerce.number().int().min(1).max(500).default(100),
    /** Drop outbound WS frames when the socket buffer exceeds this (bytes). */
    WS_SEND_BUFFER_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

    WORKER_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().default(2),
    WORKER_CONCURRENCY_OUTBOX: z.coerce.number().int().positive().default(8),
    WORKER_CONCURRENCY_PLATFORM_MESSAGE: z.coerce.number().int().positive().default(10),
    WORKER_CONCURRENCY_PUSH: z.coerce.number().int().positive().default(10),
    WORKER_CONCURRENCY_AGENCY_AUTO_REPLY: z.coerce.number().int().positive().default(20),
    WORKER_CONCURRENCY_LIVE_SESSION: z.coerce.number().int().positive().default(5),
    WORKER_CONCURRENCY_MESSAGE_MEDIA: z.coerce.number().int().positive().default(4),

    // LiveKit
    LIVEKIT_URL: z.string().url().optional(),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),

    EPAY_BASE_URL: z.string().url().default('https://epay.invalid'),
    EPAY_API_KEY: z.string().min(1).default('epay-test-key'),
    EPAY_WEBHOOK_SECRET: z.string().min(1).default('epay-test-secret'),

    /** Shared secret for LiveKit backend → ol-node-rest live session webhooks (must match LiveKit server). */
    LIVE_WEBHOOK_SECRET: z.string().min(32),
    LIVE_SESSION_TIMEOUT_HOURS: z.coerce.number().int().positive().default(6),

    // Wallet / coins
    COIN_TOPUP_RATE_LIMIT_MAX: z.coerce.number().default(5),
    COIN_TOPUP_RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
    /** When true, aggregate per-route p50/p95/p99 in memory (lab soak). */
    LAB_REQUEST_METRICS: z.coerce.boolean().default(false),
    /** When true with LAB_REQUEST_METRICS, rate-limit uses in-memory store (avoids Redis command burn during soak). */
    LAB_INMEMORY_RATE_LIMIT: z.coerce.boolean().default(false),
    POINTS_WITHDRAW_MIN: z.coerce.bigint().default(6700n),
    POINTS_WITHDRAW_MAX_WEEKLY: z.coerce.bigint().default(1050000n),
    POINTS_TO_USD_RATE: z.coerce.number().default(210),

    /** @deprecated Gifts use fixed 60% share in `host-revenue-shares.ts`; kept for env compat only. */
    GIFT_COIN_TO_POINT_RATE: z.coerce.number().positive().default(0.6),

    /** Comma-separated user UUIDs allowed to call gift/gallery admin APIs */
    ADMIN_USER_IDS: z
      .string()
      .optional()
      .transform((s) =>
        s
          ? s
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
      ),

    /** When not the string `true`, scheduled monthly rich-tier rollover master no-ops (admin `force` still runs). */
    RICH_TIER_ROLLOVER_ENABLED: z
      .string()
      .optional()
      .transform((s) => s === 'true'),

    /** When not `true`, scheduled agency level recompute master no-ops (admin enqueue still works). */
    AGENCY_LEVEL_RECOMPUTE_ENABLED: z
      .string()
      .optional()
      .transform((s) => s === 'true'),

    /**
     * When not the string `false`, agency tier window total includes unreversed
     * gift/video-call host POINT credits in the precise `[now − duration, now)`
     * window (includes agency owner when they earn as a host). Default **on**.
     */
    AGENCY_TIER_INCLUDE_HOST_EARNINGS: z
      .string()
      .optional()
      .transform((s) => s !== 'false'),

    /**
     * When `true`, agency tier window total also includes unreversed `AGENT_COMMISSION`
     * ledger credits in the precise `[now − duration, now)` window. Default **off**.
     */
    AGENCY_TIER_INCLUDE_AGENCY_COMMISSION: z
      .string()
      .optional()
      .transform((s) => s === 'true'),

    /** VIP-pattern IDs to classify ahead of `next_public_id_sequence.next_value` (numeric string or number). */
    PUBLIC_ID_PREGEN_HORIZON_AHEAD: z.coerce.bigint().default(1_000_000n),
    PUBLIC_ID_PREGEN_BATCH_SIZE: z.coerce.number().default(5_000),
    /** Fallback when sequence row missing (matches signup sequence default). */
    PUBLIC_ID_INITIAL_VALUE: z.coerce.bigint().default(34_216_589n),

    /** Rare public ID purchase duration (store); separate from paid VIP membership. */
    STORE_RARE_ID_DURATION_DAYS: z.coerce.number().default(15),

    /** Max recent messages per conversation in Redis hot sorted set (`conv:{id}:messages`). */
    MSG_HOT_CACHE_SIZE: z.coerce.number().int().min(10).max(500).default(40),

    /** Optional override prices (credits) for rare IDs by tier rank: 1=BRONZE … 4=DIAMOND. */
    VIP_PRICE_TIER_1: z.coerce.number().optional(),
    VIP_PRICE_TIER_2: z.coerce.number().optional(),
    VIP_PRICE_TIER_3: z.coerce.number().optional(),
    VIP_PRICE_TIER_4: z.coerce.number().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.AGENCY_TIER_INCLUDE_HOST_EARNINGS && !val.AGENCY_TIER_INCLUDE_AGENCY_COMMISSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENCY_TIER_INCLUDE_HOST_EARNINGS'],
        message:
          'At least one of AGENCY_TIER_INCLUDE_HOST_EARNINGS or AGENCY_TIER_INCLUDE_AGENCY_COMMISSION must be enabled',
      })
    }
    if (val.NODE_ENV === 'production' && !val.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET is required in production and must be different from JWT_ACCESS_SECRET',
      })
    }
    if (val.NODE_ENV === 'production' && !val.DEVICE_FINGERPRINT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEVICE_FINGERPRINT_SECRET'],
        message: 'DEVICE_FINGERPRINT_SECRET is required in production (min 32 chars)',
      })
    }
    if (val.OTP_DELIVERY_ENABLED) {
      const requiredDeliveryVars: Array<keyof typeof val> = [
        'MSG91_AUTH_KEY',
        'MSG91_SMS_TEMPLATE_ID',
        'MSG91_WHATSAPP_TEMPLATE_ID',
        'MSG91_WHATSAPP_SENDER',
        'MSG91_SENDER_ID',
        'MSG91_DLT_ENTITY_ID',
        'SES_FROM_EMAIL',
        'SES_ACCESS_KEY_ID',
        'SES_SECRET_ACCESS_KEY',
        'AWS_REGION',
      ]
      for (const key of requiredDeliveryVars) {
        if (!val[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when OTP_DELIVERY_ENABLED=true`,
          })
        }
      }
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
