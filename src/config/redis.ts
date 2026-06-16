import { Redis } from 'ioredis'
import { env } from './env'

const redisOptions = {
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times: number) {
    if (times > 5) return null
    return Math.min(times * 200, 2000)
  },
}

export const redisClient = new Redis(env.REDIS_URL, redisOptions)

redisClient.on('connect', () => console.info('✅ Redis connected'))
redisClient.on('error', (err) => console.error('❌ Redis error:', err))

/** Read replica client when REDIS_READ_URL is set; use for read-only ops to reduce load on primary. */
export const redisReadClient: Redis | null = env.REDIS_READ_URL
  ? new Redis(env.REDIS_READ_URL, redisOptions)
  : null

if (redisReadClient) {
  redisReadClient.on('connect', () => console.info('✅ Redis read replica connected'))
  redisReadClient.on('error', (err) => console.error('❌ Redis read error:', err))
}

/** Client to use for read-only Redis ops (get, ping). Uses read replica when set. */
export function getRedisForRead(): Redis {
  return redisReadClient ?? redisClient
}

export const RedisKeys = {
  userAuthIdentifiers: (userId: string) => `user:${userId}:auth_identifiers`,
  /** Permanent VIP inventory: IDs that are reserved (no TTL). */
  vipReserved: () => 'vip:reserved',
  /** VIP pool per tier (sorted set, no TTL). */
  vipPool: (tier: string) => `vip:pool:${tier}`,
  /** VIP metadata hash per public ID (no TTL). */
  vipMeta: (publicId: bigint | string | number) => `vip:meta:${publicId}`,
  vipNextPublicId: () => 'vip:next_public_id',
  /** Permanent base publicId. Written once at registration. No TTL ever. NX on write. */
  userOriginalId: (userId: string) => `user:original_id:${userId}`,
  /** Active VIP publicId. TTL = remaining subscription seconds. When Redis drops this key the subscription has ended — fallback is automatic. */
  userActiveVipId: (userId: string) => `user:active_vip:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  /** Cached user.tokenVersion for O(1) access checks (invalidated on bump). */
  userTokenVersion: (userId: string) => `user:${userId}:token_version`,
  /** Single-flight lock for refresh rotation per session. */
  refreshLock: (sessionId: string) => `lock:refresh:${sessionId}`,
  deviceLastActive: (deviceId: string) => `device:${deviceId}:lastActive`,
  rateLimitLogin: (identifier: string, ip: string) => `ratelimit:login:${identifier}:${ip}`,
  signupVerified: (provider: string, identifier: string) =>
    `signup:verified:${provider}:${identifier}`,
  passwordResetToken: (resetToken: string) => `password_reset:${resetToken}`,
  emailModifyInProgress: (userId: string) => `email_modify:${userId}`,
  phoneModifyInProgress: (userId: string) => `phone_modify:${userId}`,
  /** Per-endpoint auth rate limit: ratelimit:auth:{endpoint}:{ip} */
  authRateLimit: (endpoint: string, ip: string) => `ratelimit:auth:${endpoint}:${ip}`,
  /** Per-user security password rate limit */
  securityPasswordRateLimit: (endpoint: string, userId: string) =>
    `ratelimit:security:${endpoint}:${userId}`,
  securityPasswordResetToken: (token: string) => `security:password:reset-token:${token}`,
  securityPasswordChangeToken: (token: string) => `security:password:change-token:${token}`,
  userSecurityIdentifiers: (userId: string) => `user:${userId}:security:identifiers`,
  userSecurityPasswordExists: (userId: string) => `user:${userId}:security:password:exists`,
  userSecurityPasswordLocked: (userId: string) => `user:${userId}:security:password:locked`,
  /** Device management: list of user's devices (TTL 5 min). */
  userDevices: (userId: string) => `user:${userId}:devices`,
  /** Device management: user's sessions cache invalidation. */
  userSessions: (userId: string) => `user:${userId}:sessions`,
  /** Per-user device endpoint rate limit. */
  deviceRateLimit: (endpoint: string, userId: string) => `ratelimit:device:${endpoint}:${userId}`,
  /** Privacy: full settings with descriptions (GET /settings). */
  userPrivacySettings: (userId: string) => `user:${userId}:privacy:settings`,
  /** Privacy: minimal booleans for other services. */
  userPrivacyData: (userId: string) => `user:${userId}:privacy:data`,
  /** Per-user privacy endpoint rate limit. */
  privacyRateLimit: (endpoint: string, userId: string) => `ratelimit:privacy:${endpoint}:${userId}`,
  /** Per-user account deletion rate limit. */
  accountDeletionRateLimit: (endpoint: string, userId: string) =>
    `ratelimit:account-deletion:${endpoint}:${userId}`,
  /** Deletion status cache (TTL 1h). */
  userDeletionStatus: (userId: string) => `user:${userId}:deletion-status`,
  /** Social graph counts cache (followers/following/friends). */
  socialCounts: (userId: string) => `social:counts:${userId}`,
  /** Visitor cooldown (profileId + visitorId). */
  visitorCooldown: (profileId: string, visitorId: string) =>
    `visitor:cooldown:${profileId}:${visitorId}`,
  /** Per-user social endpoint rate limit. */
  socialRateLimit: (endpoint: string, userId: string) => `ratelimit:social:${endpoint}:${userId}`,
  /** User level cache. */
  userLevel: (userId: string) => `user:${userId}:level`,
  /** User settings cache (language + messaging privacy). */
  userSettings: (userId: string) => `user:${userId}:settings`,
  /** Device-linked accounts cache (accounts available on a physical device). */
  deviceLinkedAccounts: (deviceId: string) => `device:${deviceId}:linked`,
  /** Messaging: conversation cache. */
  conversation: (id: string) => `conversation:${id}`,
  /** Messaging: user's conversation list. */
  userConversations: (userId: string) => `user:${userId}:conversations`,
  /** Messaging: recent messages sorted set per conversation. */
  convMessages: (conversationId: string) => `conv:${conversationId}:messages`,
  /** Messaging: unread count per user per conversation. */
  unreadCount: (userId: string, convId: string) => `unread:${userId}:${convId}`,
  /** Messaging: user online status. */
  userOnlineStatus: (userId: string) => `online:${userId}`,
  /** Messaging: cached conversation membership for WS typing path (60s). */
  convMember: (conversationId: string, userId: string) => `conv:member:${conversationId}:${userId}`,
  /** Messaging: typing publish throttle (SET NX, 2s). */
  typingThrottle: (conversationId: string, userId: string) =>
    `typing:throttle:${conversationId}:${userId}`,
  /** Messaging: typing indicator per conversation per user. */
  userTyping: (convId: string, userId: string) => `typing:${convId}:${userId}`,
  /** Messaging: open WebSocket count per user (presence). */
  presenceCount: (userId: string) => `presence:count:${userId}`,
  /** Messaging: Redis pub/sub for PRESENCE frames for a user (lazy JOIN_PRESENCE). */
  presenceChannel: (userId: string) => `presence:user:${userId}`,
  /** Messaging: per-user thin digest for badge/list when not in conv room (Phase 7). */
  userInboxChannel: (userId: string) => `msg:user:${userId}`,
  /** One-time WebSocket upgrade ticket (GETDEL on connect). TTL 15m. */
  wsTicket: (token: string) => `ws:ticket:${token}`,
  /**
   * Messaging: Redis pub/sub channel for conversation realtime frames (`ServerFrame` JSON).
   * Same logical channel as legacy `conv:{id}:events`; migrated name for clarity.
   */
  convChannel: (conversationId: string) => `msg:conv:${conversationId}`,
  /** Messaging: send message rate limit per user. */
  msgRateLimit: (userId: string) => `ratelimit:msg:send:${userId}`,
  /** Messaging: create conversation rate limit per user. */
  convCreateRateLimit: (userId: string) => `ratelimit:conv:create:${userId}`,
  /** Messaging: reaction rate limit per user. */
  reactionRateLimit: (userId: string) => `ratelimit:reaction:${userId}`,
  /** Messaging: media upload rate limit per user. */
  mediaUploadRateLimit: (userId: string) => `ratelimit:media:upload:${userId}`,
  /** Messaging: block rate limit per user. */
  blockRateLimit: (userId: string) => `ratelimit:block:${userId}`,
  /** Messaging: report rate limit per user. */
  reportRateLimit: (userId: string) => `ratelimit:report:${userId}`,
  /** Messaging: block list cache per user (v2 includes blocked user avatarUrl). */
  blockList: (userId: string) => `blocklist:v2:${userId}`,
  /** Messaging: allowed sender cache (recipientId, senderId) — 60s TTL to avoid repeated follow checks. */
  allowedMessaging: (recipientId: string, senderId: string) =>
    `allowed-messaging:${recipientId}:${senderId}`,
  /** GET /users/me JSON cache */
  userMe: (userId: string) => `user:me:${userId}`,
  /** Full profile cache (same payload shape as /me for now). */
  userProfile: (userId: string) => `user:profile:${userId}`,
  /** Display-name change lock (TTL = seconds until next calendar month UTC). */
  userUsernameLock: (userId: string) => `user:username_lock:${userId}`,
  // Wallet Redis keys
  walletCoinBalance: (userId: string) => `wallet:coins:${userId}`,
  walletPointBalance: (userId: string) => `wallet:points:${userId}`,
  /** Cached unconfirmed (in-flight escrow) points for a POINT wallet. */
  walletPointsUnconfirmed: (userId: string) => `wallet:points:unconfirmed:${userId}`,
  ctBalance: (userId: string) => `ct:balance:${userId}`,
  ctRecentUsers: (userId: string) => `ct:recent-users:${userId}`,
  ctTopupRates: () => 'ct:topup-rates',
  ctTopupPackages: () => 'ct:topup-packages',
  ctExchangeRates: () => 'ct:exchange-rates',
  ctExchangePackages: (userType: 'agent' | 'personal') => `ct:exchange-packages:${userType}`,
  coinsellerSettings: (agencyUserId: string) => `agency:coinseller:${agencyUserId}`,
  walletIdem: (key: string) => `wallet:idem:${key}`,
  walletRateLimit: (userId: string, action: string) => `wallet:rl:${userId}:${action}`,
  /** Wallet ledger level snapshots (wealth / livestream cumulative credits). */
  userWealthLevel: (userId: string) => `level:wealth:${userId}`,
  userLivestreamLevel: (userId: string) => `level:stream:${userId}`,
  levelConfigWealth: () => `level:config:wealth`,
  levelConfigStream: () => `level:config:stream`,
  giftList: () => `gifts:list`,
  giftByTag: (tag: string) => `gifts:tag:${tag}`,
  /** Global gallery structure for a UTC month (admin-defined template). */
  giftGalleryTemplate: (year: number, month: number) => `gallery:template:${year}:${month}`,
  /** Per-host merged payload (template + that host's progress). */
  giftGalleryHost: (hostUserId: string, year: number, month: number) =>
    `gallery:${hostUserId}:${year}:${month}`,
  fanRanking: (hostUserId: string, periodType: string, periodKey: string) =>
    `fanrank:${hostUserId}:${periodType}:${periodKey}`,
  giftSendRateLimit: (userId: string) => `rl:gift:send:${userId}`,
  /** O(1) paid subscription access: subscriber may view creator subscriber-only content while key exists. */
  subscriptionAccess: (subscriberId: string, creatorId: string) =>
    `sub:access:${subscriberId}:${creatorId}`,
  /** Cached ACTIVE paid subscriber count per creator (display stat). */
  subscriptionCreatorCount: (creatorId: string) => `sub:count:${creatorId}`,
  /** Per-user cap for mutating subscription routes (after JWT). */
  subscriptionMutationRateLimit: (userId: string) => `ratelimit:subscription:mut:${userId}`,
  /** Country-scoped top creators by ACTIVE subscriber count (discovery). */
  subscriptionTopCreators: (country: string) => `sub:top-creators:${country}`,
  /** App-wide top creators by ACTIVE subscriber count (country fallback). */
  subscriptionTopCreatorsGlobal: () => `sub:top-creators:global`,
  /** App-wide top creators by post count (last-resort fallback). */
  subscriptionTopCreatorsByPosts: () => `sub:top-creators:global:posts`,
  subscriptionTopCreatorsRateLimit: (userId: string) =>
    `ratelimit:subscription:top-creators:${userId}`,
  subscriptionFeedRateLimit: (userId: string) => `ratelimit:subscription:feed:${userId}`,
  /** Cached top active guardian for a target profile card. */
  guardianActive: (targetUserId: string) => `guardian:active:${targetUserId}`,
  /** Cached super-host flag for a profile card. */
  superHostStatus: (targetUserId: string) => `superhost:status:${targetUserId}`,
  /** Users I am guarding (list response cache). */
  guardianMyList: (userId: string) => `guardian:my:${userId}`,
  /** Users guarding me (list response cache). */
  guardianMeList: (userId: string) => `guardian:me:${userId}`,
  /** POST /guardian purchase throttle (per user). */
  guardianPurchaseRateLimit: (userId: string) => `ratelimit:guardian:purchase:${userId}`,
  // Support system
  supportTicketList: (userId: bigint | string) => `support:tickets:user:${userId}`,
  supportTicketDetail: (ticketId: bigint | string) => `support:ticket:${ticketId}`,
  supportRateLimit: (userId: bigint | string) => `ratelimit:support:create:${userId}`,
  // Store system
  storeCatalog: (category?: string) =>
    category ? `store:catalog:${category}` : 'store:catalog:all',
  storeItem: (itemId: string) => `store:item:${itemId}`,
  userActiveStore: (userId: string) => `store:active:${userId}`,
  userStoreItems: (userId: string) => `store:owned:${userId}`,
  storeRareIds: () => 'store:rare-ids',
  storePurchaseRateLimit: (userId: string) => `ratelimit:store:purchase:${userId}`,
  storeRareIdPurchaseRateLimit: (userId: string) => `ratelimit:store:rare-id:${userId}`,
  /** Rich tier read-through snapshot (tier/progress for current UTC month). */
  richState: (userId: string) => `rich:state:${userId}`,
  /** Cached monthly recharge total for a UTC month (invalidated on recharge + rollover). */
  richProgress: (userId: string, year: number, month: number) =>
    `rich:progress:${userId}:${year}:${month}`,
  richConfig: () => `rich:config`,
  ratelimitRichRead: (userId: string) => `ratelimit:rich:read:${userId}`,
  /** Paid VIP membership (Diamond/SVIP) active snapshot: JSON `{ tier, expiresAt }` or `null`. */
  vipmActive: (userId: string) => `vipm:active:${userId}`,
  /** Static VIP membership pricing/config cache (optional; service may inline). */
  vipmConfig: () => `vipm:config`,
  ratelimitVipmPurchase: (userId: string) => `ratelimit:vip-membership:purchase:${userId}`,
  ratelimitVipmClaim: (userId: string) => `ratelimit:vip-membership:claim:${userId}`,
  /** Agency: GET /users/me agency block cache bust target */
  agencyMe: (userId: string) => `agency:me:${userId}`,
  agencyByPublicId: (publicId: string) => `agency:pub:${publicId}`,
  /** Bump segment when ranking item shape changes — avoids stale Redis payloads. */
  agencyRanking: (country: string, period: string, limit: number, cursor: string) =>
    `agency:ranking:v5:${country}:${period}:${limit}:${cursor}`,
  /** Throttle User.lastActiveAt DB writes (10 min window presence key). */
  userLastActive: (userId: string) => `user:lastActive:${userId}`,
  ratelimitAgencyApply: (userId: string) => `ratelimit:agency:apply:${userId}`,
  ratelimitAgencyLeaveApply: (userId: string) => `ratelimit:agency:leave:apply:${userId}`,
  /** Agency Phase 2: level ladder + derived rates (60s) */
  agencyRate: (agencyUserId: string) => `agency:rate:${agencyUserId}`,
  /** Commission GET /me / panel fragments */
  agencyCommissionMe: (agencyUserId: string, periodKey?: string | number) =>
    periodKey != null
      ? `agency:commission:me:${agencyUserId}:${periodKey}`
      : `agency:commission:me:${agencyUserId}`,
  agencyHostBreakdown: (agencyUserId: string, period: string) =>
    `agency:host:breakdown:${agencyUserId}:${period}`,
  agencyLevelConfig: () => `agency:level:config`,
  ratelimitAgencyPointTransfer: (userId: string) => `ratelimit:agency:point-transfer:${userId}`,
  /** Agency dashboard: earnings & commission overview per period label (30s TODAY / 60s others). */
  agencyDashboardEarnings: (agencyUserId: string, periodLabel: string) =>
    `agency:dashboard:earnings:${agencyUserId}:${periodLabel}`,
  /** Agency dashboard: host data summary per period label. */
  agencyDashboardHostSummary: (agencyUserId: string, periodLabel: string) =>
    `agency:dashboard:hosts:${agencyUserId}:${periodLabel}`,
  /** Agency dashboard: "earned today" + accumulated + points balance (30s). */
  agencyDashboardToday: (agencyUserId: string) => `agency:dashboard:today:${agencyUserId}`,
  /** Agency dashboard: shared read rate-limit bucket across all dashboard endpoints. */
  ratelimitAgencyDashboard: (userId: string) => `ratelimit:agency:dashboard:${userId}`,
  ratelimitCtTopup: (userId: string) => `ratelimit:ct:topup:${userId}`,
  ratelimitCtExchange: (userId: string) => `ratelimit:ct:exchange:${userId}`,
  ratelimitCtTransfer: (userId: string) => `ratelimit:ct:transfer:${userId}`,
  questionnaireActive: (key: string) => `questionnaire:active:${key}`,
  questionnaireActiveFull: (key: string) => `questionnaire:active-full:${key}`,
  questionnaireUserStatus: (userId: string, key: string) =>
    `questionnaire:user-status:${userId}:${key}`,
  questionnaireSubmitRateLimit: (userId: string, key: string) =>
    `ratelimit:questionnaire:submit:${userId}:${key}`,
  questionnaireAdminRateLimit: (userId: string) => `ratelimit:questionnaire:admin:${userId}`,
  faceRegisterLock: (userId: string) => `face:register:lock:${userId}`,
  faceRegisterRateLimit: (userId: string) => `ratelimit:face:register:${userId}`,
  faceVerifyRateLimitUser: (userId: string) => `ratelimit:face:verify:${userId}`,
  faceVerifyRateLimitIp: (ip: string) => `ratelimit:face:verify:ip:${ip}`,
  faceRegisterIdem: (userId: string, clientRequestId: string) =>
    `face:register:idem:${userId}:${clientRequestId}`,
  faceVerifyIdem: (userId: string, clientRequestId: string) =>
    `face:verify:idem:${userId}:${clientRequestId}`,
  faceVerifyLastPass: (userId: string) => `face:verify:lastpass:${userId}`,
  /** Live photo GET /me cache (cache-aside JSON). */
  livePhotoProfile: (userId: string) => `live-photo:profile:${userId}`,
  /** Distributed lock during CompareFaces worker segment. */
  livePhotoVerifyLock: (userId: string) => `live-photo:lock:${userId}`,
  /** Short-lived processing hint for status pollers. */
  livePhotoVerifyStatus: (userId: string) => `live-photo:verify-status:${userId}`,
  ratelimitLivePhotoUploadUrl: (userId: string) => `ratelimit:live-photo:upload-url:${userId}`,
  ratelimitLivePhotoVerify: (userId: string) => `ratelimit:live-photo:verify:${userId}`,
  faceRegistrationSessionRate: (userId: string) => `ratelimit:face-registration:session:${userId}`,
  faceRegistrationVerifyRate: (userId: string) => `ratelimit:face-registration:verify:${userId}`,
  faceRegistrationLock: (userId: string) => `face-registration:lock:${userId}`,
  faceRegistrationVerifyIdem: (sessionId: string, idempotencyKey: string) =>
    `face-registration:verify:idem:${sessionId}:${idempotencyKey}`,
  /** Short TTL replay guard: first N bytes hash of supplemental video. */
  faceRegistrationReplayGuard: (hash: string) => `face-registration:replay:${hash}`,
  /** Phase 3b payroll / withdrawal */
  payrollConfig: () => 'payroll:config',
  payoutRailConfig: () => 'withdrawal:payout-rail-config',
  userPaymentMethods: (userId: string) => `pmethods:${userId}`,
  ratelimitWithdrawalCreate: (userId: string) => `ratelimit:withdrawal:create:${userId}`,
  ratelimitWithdrawalDispute: (userId: string) => `ratelimit:withdrawal:dispute:${userId}`,
  ratelimitPayrollComplete: (userId: string) => `ratelimit:payroll:complete:${userId}`,
  ratelimitPayrollReject: (userId: string) => `ratelimit:payroll:reject:${userId}`,
  ratelimitPmBind: (userId: string) => `ratelimit:pm:bind:${userId}`,
  payrollSummary: (agencyUserId: string) => `payroll:summary:${agencyUserId}`,
  /** Agent payroll summary with period earnings; periodKey = `30` or `2026-01-01_2026-01-31`. */
  payrollSummaryPeriod: (agencyUserId: string, periodKey: string) =>
    `payroll:summary:${agencyUserId}:${periodKey}`,
  /** Active live stream session metadata (JSON: sessionId, agencyUserId, startedAt, roomId). */
  liveActiveSession: (hostUserId: string) => `live:active:${hostUserId}`,
  /** Reserved for future rate limiting on session start. */
  liveStartRateLimit: (hostUserId: string) => `live:rl:start:${hostUserId}`,
} as const

/** TTL in seconds for user auth identifiers cache (1 hour). */
export const AUTH_IDENTIFIERS_CACHE_TTL = 3600

/** TTL in seconds for user devices list cache (5 min). */
/** Short TTL to limit stampede after invalidations (see docs/auth-v2-flow.md). */
export const USER_DEVICES_CACHE_TTL = 60

/** Messaging: recent messages sorted set TTL (2h). */
export const MSG_HOT_TTL = 60 * 60 * 2
/** Messaging: conversation list per user TTL (5m). */
export const CONV_LIST_TTL = 60 * 5
/** Messaging: online status TTL (30s; DM list cache / legacy). */
export const ONLINE_STATUS_TTL = 30
/** Messaging: PING heartbeat refresh for `online:{userId}` (Phase 3 presence). */
export const PRESENCE_HEARTBEAT_TTL_SEC = 60
/** Messaging: typing indicator key TTL (Phase 3 spec: 8s). */
export const TYPING_INDICATOR_TTL_SEC = 8
/** Messaging: max one typing publish per user per conversation per 2s. */
export const TYPING_THROTTLE_TTL_SEC = 2
/** Messaging: cached conv membership for typing (60s). */
export const CONV_MEMBER_CACHE_TTL_SEC = 60
/** Messaging: coalesce READ WS frames before DB + fan-out (ms). */
export const READ_RECEIPT_DEBOUNCE_MS = 5000
/** Messaging: typing indicator TTL (5s) — hot-cache / non-WS paths. */
export const TYPING_TTL = 5
/** WebSocket upgrade ticket TTL (15m). */
export const WS_TICKET_TTL_SEC = 60 * 15
/** Messaging: block list per user TTL (1h). */
export const BLOCK_LIST_TTL = 60 * 60

/** Wallet: cached balance TTL (5 minutes). */
export const WALLET_BALANCE_TTL = 300
export const CT_BALANCE_TTL = 300
export const CT_RECENT_USERS_TTL = 120
export const CT_RATES_TTL = 3600
export const COINSELLER_SETTINGS_TTL = 300
/** Wallet: idempotency key TTL (5 minutes). */
export const WALLET_IDEM_TTL = 300
/** Wallet: per-action rate limit window (1 minute). */
export const WALLET_RL_TTL = 60

/** Wallet ledger levels: per-user snapshot TTL (refreshed on each credit). */
export const USER_LEVEL_TTL = 300
/** Wallet level threshold list cache (config changes rarely). */
export const LEVEL_CONFIG_TTL = 3600

/** Gift catalog list / per-tag cache (10 min). */
export const GIFT_LIST_CACHE_TTL = 600
/** Per-host merged gift gallery cache (5 min). */
export const GALLERY_HOST_TTL = 300
/** Global gallery template cache (10 min; invalidated on admin upsert). */
export const GALLERY_TEMPLATE_TTL = 600
/** @deprecated Use GALLERY_HOST_TTL */
export const GIFT_GALLERY_CACHE_TTL = GALLERY_HOST_TTL
/** Fan ranking: day period (2 min). */
export const FAN_RANK_DAY_TTL = 120
/** Fan ranking: week / month (5 min). */
export const FAN_RANK_WEEK_MONTH_TTL = 300

/** Paid subscriber count cache per creator (eventually consistent display stat). */
export const SUBSCRIPTION_COUNT_CACHE_TTL = 300

/** Top creators by country (shared across users in that country). */
export const SUB_TOP_CREATORS_TTL = 300

/** Guardian: active top guardian per target (recalculated on purchase/expiry). */
export const GUARDIAN_ACTIVE_TTL = 300
/** Guardian: my-guardians / guarding-me list cache. */
export const GUARDIAN_LIST_TTL = 120
/** Super-host status cache for profile short lookups. */
export const SUPER_HOST_STATUS_TTL = 300

/** Support: cached ticket list for a user (page 1, no status filter). */
export const SUPPORT_TICKET_LIST_TTL = 60
/** Support: ticket detail cache (reserved for future use; invalidated on mutation). */
export const SUPPORT_TICKET_DETAIL_TTL = 30

export const STORE_CATALOG_TTL = 600
export const STORE_ITEM_TTL = 600
export const USER_ACTIVE_STORE_TTL = 300
export const USER_STORE_ITEMS_TTL = 120
export const STORE_RARE_IDS_TTL = 300

/** Rich tier per-user snapshot cache (invalidated on recharge + rollover). */
export const RICH_STATE_TTL = 300
/** Rich tier threshold table cache. */
export const RICH_CONFIG_TTL = 3600
/** Payroll fee config singleton cache. */
export const PAYROLL_CONFIG_TTL = 3600
/** Public withdrawal payout rail (EPAY/BANK fee + arrival copy). */
export const PAYOUT_RAIL_CONFIG_TTL = 300
/** Agent payroll dashboard summary (tab counts + toggle). */
export const PAYROLL_SUMMARY_TTL = 30
/** GET rich-tier read endpoints: 60 requests / 60s per user. */
export const RICH_READ_RL_TTL = 60

/** VIP membership: active cache TTL upper bound (service sets dynamic TTL up to this). */
export const VIPM_ACTIVE_TTL_MAX = 24 * 60 * 60
/** VIP membership: inactive / expired cache (5 min). */
export const VIPM_ACTIVE_INACTIVE_TTL = 300
/** VIP membership purchase / daily claim throttle window (60s). */
export const VIPM_MUTATION_RL_TTL = 60

/** Agency snapshot cache for ranking list (60s). */
export const AGENCY_RANKING_CACHE_TTL = 60
/** Agency single-record caches */
export const AGENCY_ME_CACHE_TTL = 60
export const AGENCY_BY_PUBLIC_ID_CACHE_TTL = 300
/** Agency Phase 2 */
export const AGENCY_LEVEL_CONFIG_CACHE_TTL = 3600
export const AGENCY_RATE_CACHE_TTL = 60
export const AGENCY_COMMISSION_ME_CACHE_TTL = 60
export const AGENCY_HOST_BREAKDOWN_CACHE_TTL = 300
/** Agency dashboard: fast-refresh cache for the live "earned today" figures (30s). */
export const DASHBOARD_TTL_TODAY = 30
/** Agency dashboard: 1-minute cache for historical / period aggregates. */
export const DASHBOARD_TTL_PERIOD = 60
/** Active live session Redis marker — slightly over max session timeout. */
export const LIVE_ACTIVE_SESSION_TTL = 25 * 60 * 60
/** POST /agency/transfer-points */
export const AGENCY_POINT_TRANSFER_RL_TTL = 60
/** lastActiveTracker middleware — skip DB write if key exists (600s). */
export const USER_LAST_ACTIVE_THROTTLE_TTL = 600
export const QUESTIONNAIRE_ACTIVE_TTL = 600
export const QUESTIONNAIRE_USER_STATUS_TTL = 3600
export const QUESTIONNAIRE_SUBMIT_RL_TTL = 60
export const QUESTIONNAIRE_ADMIN_RL_TTL = 60
export const FACE_REGISTER_LOCK_TTL = 30
export const FACE_REGISTER_IDEM_TTL = 24 * 60 * 60
export const FACE_VERIFY_IDEM_TTL = 60
export const FACE_VERIFY_LAST_PASS_TTL = 60

export async function redisPipeline(commands: [string, ...unknown[]][]): Promise<unknown[]> {
  const pipe = redisClient.pipeline()
  for (const [cmd, ...args] of commands) {
    ;(pipe as unknown as Record<string, (...a: unknown[]) => unknown>)[cmd.toLowerCase()](...args)
  }
  const results = await pipe.exec()
  if (!results) {
    throw new Error('Redis pipeline failed to execute')
  }

  // Collect ALL per-command errors before throwing so callers and logs see the
  // full picture of partial failures rather than only the first error encountered.
  const failures: string[] = []
  const values: unknown[] = []
  for (let i = 0; i < results.length; i++) {
    const [err, result] = results[i]
    if (err) {
      failures.push(`cmd ${i + 1} (${commands[i]![0]}): ${(err as Error).message}`)
    } else {
      values.push(result)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Redis pipeline had ${failures.length} failed command(s) — ${failures.join('; ')}`,
    )
  }
  return values
}
