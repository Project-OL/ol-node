/** BullMQ — transactional WS publish pipeline for DM messages. */
export const MESSAGE_OUTBOX_QUEUE = 'message-outbox'

export const MESSAGE_OUTBOX_PUBLISH_JOB = 'publish-outbox-row'

/** Recover rows stuck between Redis publish and DB mark-published (every 5s). */
export const MESSAGE_OUTBOX_SWEEP_JOB = 'sweep-stale-outbox'
