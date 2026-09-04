/**
 * Maps our internal `AppError.code` to BAISHUN's numeric error code (Table 2 of their
 * integration doc). Their client parses `data.code`, not our HTTP status, so every
 * game-webhooks route always responds HTTP 200 with their `{code, message, unique_id, data}`
 * envelope — `code` is what carries the failure.
 */
export const BAISHUN_ERROR_CODE_MAP: Record<string, number> = {
  GAME_LAUNCH_CODE_INVALID: 1001,
  INVALID_REQUEST: 1002,
  GAME_SESSION_NOT_FOUND: 1002,
  GAME_SESSION_EXPIRED: 1002,
  INVALID_SIGNATURE: 1003,
  GAME_SIGNATURE_NONCE_REPLAY: 1003,
  GAME_TIMESTAMP_EXPIRED: 1003,
  GAME_PROVIDER_NOT_CONFIGURED: 1007,
  INSUFFICIENT_COINS: 1008,
  GAME_NOT_FOUND: 1012,
  GAME_PROVIDER_INACTIVE: 1019,
  GAME_HOUSE_NOT_CONFIGURED: 1021,
  USER_BANNED: 1020,
  USER_NOT_FOUND: 1002,
}

/** Fallback when an AppError code has no explicit mapping above. */
export const BAISHUN_DEFAULT_ERROR_CODE = 1021
