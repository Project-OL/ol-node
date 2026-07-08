export const PLATFORM_MESSAGE_QUEUE = 'platform-message'

export const PLATFORM_LEDGER_MESSAGE_JOB = 'platform-ledger-message'
export const PLATFORM_WITHDRAWAL_MESSAGE_JOB = 'platform-withdrawal-message'
export const PLATFORM_NOTIFICATION_BROADCAST_JOB = 'platform-notification-broadcast'
export const PLATFORM_NOTIFICATION_BROADCAST_BATCH_JOB = 'platform-notification-broadcast-batch'
export const PLATFORM_BROADCAST_SWEEP_JOB = 'platform-broadcast-sweep'

/**
 * Recipients per batch job. Mirrors the message-outbox sweep page size (`take: 200`);
 * with the platform worker's concurrency=10 a 50k broadcast becomes 250 short jobs
 * instead of one multi-hour serial loop.
 */
export const BROADCAST_BATCH_SIZE = 200
/** A pending batch older than this with no live BullMQ job is re-enqueued by the sweep. */
export const BROADCAST_STALE_MS = 10 * 60_000
