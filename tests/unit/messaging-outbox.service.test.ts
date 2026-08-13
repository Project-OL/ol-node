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
  publishMessageOutboxRowInline,
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

describe('publishMessageOutboxRowInline', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    memberFindMany.mockReset();
    publish.mockReset();
    conversationFindUnique.mockReset();
    userFindUnique.mockReset();
    sendToUser.mockReset();
    publish.mockResolvedValue(1);
    update.mockResolvedValue({});
    sendToUser.mockResolvedValue(undefined);
  });

  // Phase 5b: the whole point of the inline path is that it never needs to
  // ask Postgres for anything — the caller already has it. Every test below
  // asserts these four calls stay at zero, which is the acceptance evidence
  // in place of a live latency benchmark (see CHANGELOG-remediation.md).
  function expectNoRedundantDbReads() {
    expect(findUnique).not.toHaveBeenCalled();
    expect(memberFindMany).not.toHaveBeenCalled();
    expect(conversationFindUnique).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
  }

  it('publishes to the conversation channel and marks published, without any DB reads', async () => {
    await publishMessageOutboxRowInline({
      outboxId: 9n,
      conversationId: 'conv-inline',
      payload: { t: 'NEW_MESSAGE', seq: 1 },
      members: [],
      conversationType: 'DIRECT',
      sender: null,
    });

    expect(publish).toHaveBeenCalledWith(
      'msg:conv:conv-inline',
      JSON.stringify({ t: 'NEW_MESSAGE', seq: 1 }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 9n },
      data: expect.objectContaining({ publishedAt: expect.any(Date) }),
    });
    expectNoRedundantDbReads();
  });

  it('publishes MESSAGE_DIGEST to other members and a push notification, using only the passed-in params', async () => {
    await publishMessageOutboxRowInline({
      outboxId: 10n,
      conversationId: 'conv-inline-2',
      payload: {
        t: 'NEW_MESSAGE',
        seq: 5,
        message: { id: 'msg-1', senderId: 'sender-1', type: 'TEXT', content: 'hi', isDeleted: false },
      },
      members: [
        { userId: 'sender-1', isMuted: false, mutedUntil: null },
        { userId: 'peer-2', isMuted: false, mutedUntil: null },
      ],
      conversationType: 'DIRECT',
      sender: { firstName: 'Sam', lastName: 'Sender', username: 'sam' },
    });

    expect(publish).toHaveBeenCalledWith(
      'msg:user:peer-2',
      JSON.stringify({
        t: 'MESSAGE_DIGEST',
        conversationId: 'conv-inline-2',
        seq: 5,
        senderId: 'sender-1',
        message: { id: 'msg-1', type: 'TEXT', content: 'hi', createdAt: undefined, isDeleted: false },
      }),
    );
    expect(sendToUser).toHaveBeenCalledWith(
      'peer-2',
      expect.objectContaining({ title: 'Sam Sender' }),
      { source: 'NEW_MESSAGE' },
    );
    expectNoRedundantDbReads();
  });

  it('does not push to a muted recipient', async () => {
    await publishMessageOutboxRowInline({
      outboxId: 11n,
      conversationId: 'conv-inline-3',
      payload: {
        t: 'NEW_MESSAGE',
        seq: 6,
        message: { id: 'msg-2', senderId: 'sender-1', type: 'TEXT', content: 'hi' },
      },
      members: [
        { userId: 'sender-1', isMuted: false, mutedUntil: null },
        { userId: 'muted-peer', isMuted: true, mutedUntil: null },
      ],
      conversationType: 'DIRECT',
      sender: { firstName: 'Sam', lastName: null, username: 'sam' },
    });

    expect(sendToUser).not.toHaveBeenCalled();
    expectNoRedundantDbReads();
  });

  it('does not push for a non-pushable conversation type', async () => {
    await publishMessageOutboxRowInline({
      outboxId: 12n,
      conversationId: 'conv-inline-4',
      payload: {
        t: 'NEW_MESSAGE',
        seq: 7,
        message: { id: 'msg-3', senderId: 'sender-1', type: 'TEXT', content: 'hi' },
      },
      members: [
        { userId: 'sender-1', isMuted: false, mutedUntil: null },
        { userId: 'peer-2', isMuted: false, mutedUntil: null },
      ],
      conversationType: 'PLATFORM_SUPPORT',
      sender: { firstName: 'Sam', lastName: null, username: 'sam' },
    });

    expect(sendToUser).not.toHaveBeenCalled();
    // Digest fan-out is independent of the push gate — still fires.
    expect(publish).toHaveBeenCalledWith('msg:user:peer-2', expect.any(String));
    expectNoRedundantDbReads();
  });
});
