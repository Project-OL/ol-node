import { prisma } from '../config/database';
import { redisClient } from '../config/redis';
import { RedisKeys } from '../config/redis';
import { enqueueMessageOutboxPublish } from '../queues/messaging.queue';

/** Publish one outbox row to Redis and mark published (at-least-once safe). */
export async function publishMessageOutboxRow(outboxId: bigint): Promise<void> {
  const row = await prisma.messageOutbox.findUnique({
    where: { id: outboxId },
  });
  if (!row || row.publishedAt) return;

  const payloadStr =
    typeof row.payload === 'string'
      ? row.payload
      : JSON.stringify(row.payload, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        );

  await redisClient.publish(RedisKeys.convChannel(row.conversationId), payloadStr);

  const parsed = JSON.parse(payloadStr) as {
    t?: string
    seq?: number
    message?: { senderId?: string }
  };
  if (parsed.t === 'NEW_MESSAGE' && parsed.message?.senderId && parsed.seq !== undefined) {
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: row.conversationId, isDeleted: false },
      select: { userId: true },
    });
    const digestStr = JSON.stringify({
      t: 'MESSAGE_DIGEST',
      conversationId: row.conversationId,
      seq: parsed.seq,
      senderId: parsed.message.senderId,
    });
    for (const m of members) {
      if (m.userId === parsed.message.senderId) continue;
      await redisClient.publish(RedisKeys.userInboxChannel(m.userId), digestStr);
    }
  }

  await prisma.messageOutbox.update({
    where: { id: outboxId },
    data: { publishedAt: new Date() },
  });
}

/** Rows older than 10s still unpublished — enqueue retry jobs (crash between publish + UPDATE). */
export async function sweepStaleMessageOutbox(): Promise<void> {
  const cutoff = new Date(Date.now() - 10_000);
  const stale = await prisma.messageOutbox.findMany({
    where: {
      publishedAt: null,
      createdAt: { lt: cutoff },
    },
    take: 200,
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const r of stale) {
    await enqueueMessageOutboxPublish(r.id);
  }
}
