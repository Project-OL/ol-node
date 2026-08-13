import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const update = vi.fn();
const outboxFindMany = vi.fn();
const memberFindMany = vi.fn();
const publish = vi.fn();
const enqueue = vi.fn();
const conversationFindUnique = vi.fn();
const userFindUnique = vi.fn();
const sendToUser = vi.fn();

vi.mock('../../src/config/database', () => ({
  prisma: {
    messageOutbox: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
      findMany: (...a: unknown[]) => outboxFindMany(...a),
    },
    conversationMember: {
      findMany: (...a: unknown[]) => memberFindMany(...a),
    },
    conversation: {
      findUnique: (...a: unknown[]) => conversationFindUnique(...a),
    },
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
    },
  },
}));

vi.mock('../../src/services/pushNotification.service', () => ({
  pushNotificationService: {
    sendToUser: (...a: unknown[]) => sendToUser(...a),
  },
}));

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    publish: (...a: unknown[]) => publish(...a),
    // Digest fan-out uses a pipeline; route each queued .publish() into the
    // same tracked `publish` fn so existing assertions see both calls.
    pipeline: () => {
      const calls: unknown[][] = [];
      const p = {
        publish: (...a: unknown[]) => {
          calls.push(a);
          publish(...a);
          return p;
        },
        get length() {
          return calls.length;
        },
        exec: () => Promise.resolve([]),
      };
      return p;
    },
  },
  RedisKeys: {
    convChannel: (id: string) => `msg:conv:${id}`,
    userInboxChannel: (id: string) => `msg:user:${id}`,
  },
}));

vi.mock('../../src/queues/messaging.queue', () => ({
  enqueueMessageOutboxPublish: (...a: unknown[]) => enqueue(...a),
}));

import {
  publishMessageOutboxRow,
  sweepStaleMessageOutbox,
} from '../../src/services/messaging-outbox.service';

describe('messaging-outbox.service', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    outboxFindMany.mockReset();
    memberFindMany.mockReset();
    publish.mockReset();
    enqueue.mockReset();
    conversationFindUnique.mockReset();
    userFindUnique.mockReset();
    sendToUser.mockReset();
    publish.mockResolvedValue(1);
    update.mockResolvedValue({});
    conversationFindUnique.mockResolvedValue({ type: 'DIRECT' });
    userFindUnique.mockResolvedValue({ firstName: 'Sender', lastName: '', username: 'sender' });
    sendToUser.mockResolvedValue(undefined);
  });

  it('publishMessageOutboxRow publishes JSON then marks publishedAt', async () => {
    findUnique.mockResolvedValueOnce({
      id: 5n,
      conversationId: 'conv1',
      payload: { t: 'NEW_MESSAGE', seq: 1 },
      publishedAt: null,
    });
    await publishMessageOutboxRow(5n);
    expect(publish).toHaveBeenCalledWith(
      'msg:conv:conv1',
      JSON.stringify({ t: 'NEW_MESSAGE', seq: 1 }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 5n },
      data: expect.objectContaining({ publishedAt: expect.any(Date) }),
    });
  });

  it('publishMessageOutboxRow no-op when already published', async () => {
    findUnique.mockResolvedValueOnce({
      id: 5n,
      conversationId: 'conv1',
      payload: {},
      publishedAt: new Date(),
    });
    await publishMessageOutboxRow(5n);
    expect(publish).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('sweepStaleMessageOutbox enqueues publish for stale rows', async () => {
    outboxFindMany.mockResolvedValueOnce([{ id: 10n }, { id: 11n }]);
    await sweepStaleMessageOutbox();
    expect(outboxFindMany).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(10n);
    expect(enqueue).toHaveBeenCalledWith(11n);
  });

  it('publishMessageOutboxRow publishes MESSAGE_DIGEST to other members (Phase 7)', async () => {
    findUnique.mockResolvedValueOnce({
      id: 7n,
      conversationId: 'conv-d',
      payload: {
        t: 'NEW_MESSAGE',
        seq: 42,
        message: { senderId: 'sender-1' },
      },
      publishedAt: null,
    })
    memberFindMany.mockResolvedValueOnce([
      { userId: 'sender-1' },
      { userId: 'peer-2' },
    ])
    await publishMessageOutboxRow(7n)
    expect(publish).toHaveBeenCalledWith(
      'msg:conv:conv-d',
      expect.any(String),
    )
    expect(publish).toHaveBeenCalledWith(
      'msg:user:peer-2',
      JSON.stringify({
        t: 'MESSAGE_DIGEST',
        conversationId: 'conv-d',
        seq: 42,
        senderId: 'sender-1',
        message: { content: null, isDeleted: false },
      }),
    )
    expect(publish.mock.calls.length).toBe(2)
  })
});
