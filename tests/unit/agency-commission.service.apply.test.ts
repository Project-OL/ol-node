import { describe, it, expect, vi, beforeEach } from "vitest";
import { PointTxType, Prisma } from "@prisma/client";
import { utcDayFromTimestamp } from "../../src/utils/datetime";

const upsertDailyEarning = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/repositories/agencyCommission.repository", () => ({
  agencyCommissionRepository: {
    upsertDailyEarning: (...a: unknown[]) => upsertDailyEarning(...a),
  },
}));

const creditInTransaction = vi.fn().mockResolvedValue({
  ledgerEntryId: "led-agent",
  balanceAfter: 1000n,
});

vi.mock("../../src/services/point-wallet.service", () => ({
  pointWalletService: {
    creditInTransaction: (...a: unknown[]) => creditInTransaction(...a),
    debit: vi.fn(),
  },
}));

import { agencyCommissionService, giftFieldsFromHostLedger } from "../../src/services/agencyCommission.service";

function txMock(hostEntry?: {
  refId?: string | null
  metadata?: unknown
  counterpartyId?: string | null
}) {
  return {
    user: {
      findUnique: vi.fn(),
    },
    agencyCommissionProcessed: {
      create: vi.fn().mockResolvedValue({}),
    },
    agency: {
      findUnique: vi.fn(),
    },
    agencyCommissionLevel: {
      findUnique: vi.fn(),
    },
    pointLedgerEntry: {
      findUnique: vi.fn().mockResolvedValue(
        hostEntry === undefined
          ? { refId: null, metadata: null, counterpartyId: null }
          : {
              refId: hostEntry.refId ?? null,
              metadata: hostEntry.metadata ?? null,
              counterpartyId: hostEntry.counterpartyId ?? null,
            },
      ),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agencyCommissionService.applyCommission", () => {
  const day = utcDayFromTimestamp(new Date("2026-05-04T12:00:00.000Z"));

  it("no agency → no processed row, no upsert, no agent credit", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: null,
    });
    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-1",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.GIFT_RECEIVE,
        day,
      },
      tx as never,
    );
    expect(tx.agencyCommissionProcessed.create).not.toHaveBeenCalled();
    expect(upsertDailyEarning).not.toHaveBeenCalled();
    expect(creditInTransaction).not.toHaveBeenCalled();
  });

  it("ineligible tx type → no processed / upsert", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-1",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.PLATFORM_REWARD,
        day,
      },
      tx as never,
    );
    expect(tx.agencyCommissionProcessed.create).not.toHaveBeenCalled();
    expect(upsertDailyEarning).not.toHaveBeenCalled();
  });

  it("D tier live 4%: 100k host pts → 4k commission + upsert", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "D",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "D",
      liveRateBp: 400,
      matchChatRateBp: 400,
    });

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-1",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.GIFT_RECEIVE,
        day,
      },
      tx as never,
    );

    expect(upsertDailyEarning).toHaveBeenCalledWith(
      expect.objectContaining({
        agencyUserId: "agent-1",
        hostUserId: "host-1",
        hostEarningsDelta: 100_000n,
        hostCommissionDelta: 4000n,
      }),
      tx,
    );
    expect(creditInTransaction).toHaveBeenCalledWith(
      "agent-1",
      4000n,
      PointTxType.AGENT_COMMISSION,
      tx,
      expect.objectContaining({
        idempotencyKey: "agency-commission:hl-1",
        refId: "hl-1",
      }),
    );
  });

  it("VIDEO_CALL uses match_chat_rate_bp column", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "D",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "D",
      liveRateBp: 9999,
      matchChatRateBp: 800,
    });

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-vc",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.VIDEO_CALL,
        day,
      },
      tx as never,
    );

    expect(creditInTransaction).toHaveBeenCalledWith(
      "agent-1",
      8000n,
      PointTxType.AGENT_COMMISSION,
      tx,
      expect.objectContaining({
        metadata: expect.objectContaining({ category: "MATCH_CHAT", rateBp: 800 }),
      }),
    );
  });

  it("duplicate processed row (P2002) → no double upsert", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "D",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "D",
      liveRateBp: 400,
      matchChatRateBp: 400,
    });
    (tx.agencyCommissionProcessed.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-dup",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.GIFT_RECEIVE,
        day,
      },
      tx as never,
    );

    expect(upsertDailyEarning).not.toHaveBeenCalled();
    expect(creditInTransaction).not.toHaveBeenCalled();
  });

  it("zero commission points → upsert daily row but no agent ledger credit", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "D",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "D",
      liveRateBp: 400,
      matchChatRateBp: 400,
    });

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-z",
        hostPointsCredited: 1n,
        hostTxType: PointTxType.GIFT_RECEIVE,
        day,
      },
      tx as never,
    );

    expect(upsertDailyEarning).toHaveBeenCalledWith(
      expect.objectContaining({
        hostCommissionDelta: 0n,
      }),
      tx,
    );
    expect(creditInTransaction).not.toHaveBeenCalled();
  });

  it("SS+ rate 24% on live gift", async () => {
    const tx = txMock();
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "SS+",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "SS+",
      liveRateBp: 2400,
      matchChatRateBp: 2400,
    });

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-ss",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.GIFT_RECEIVE,
        day,
      },
      tx as never,
    );

    expect(creditInTransaction).toHaveBeenCalledWith(
      "agent-1",
      24_000n,
      PointTxType.AGENT_COMMISSION,
      tx,
      expect.anything(),
    );
  });

  it("copies gift sender + gift details onto AGENT_COMMISSION metadata", async () => {
    const tx = txMock({
      refId: "gift-tx-1",
      counterpartyId: "sender-1",
      metadata: {
        giftId: "gift-rose",
        giftName: "Rose",
        context: "direct",
        quantity: 2,
        unitCoinCost: 100,
      },
    });
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "D",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "D",
      liveRateBp: 400,
      matchChatRateBp: 400,
    });

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-gift",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.GIFT_RECEIVE,
        day,
      },
      tx as never,
    );

    expect(creditInTransaction).toHaveBeenCalledWith(
      "agent-1",
      4000n,
      PointTxType.AGENT_COMMISSION,
      tx,
      expect.objectContaining({
        counterpartyId: "host-1",
        refId: "gift-tx-1",
        description: "Agency commission: Rose",
        metadata: expect.objectContaining({
          category: "LIVE",
          rateBp: 400,
          hostTxType: PointTxType.GIFT_RECEIVE,
          hostLedgerEntryId: "hl-gift",
          giftId: "gift-rose",
          giftName: "Rose",
          context: "direct",
          quantity: 2,
          unitCoinCost: 100,
          senderUserId: "sender-1",
        }),
      }),
    );
  });

  it("VIDEO_CALL commission metadata has no gift keys", async () => {
    const tx = txMock({
      refId: "vc-1",
      counterpartyId: "caller-1",
      metadata: { sessionId: "s1" },
    });
    (tx.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentAgencyId: "agent-1",
    });
    (tx.agency.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentLevel: "D",
    });
    (tx.agencyCommissionLevel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      level: "D",
      liveRateBp: 400,
      matchChatRateBp: 800,
    });

    await agencyCommissionService.applyCommission(
      {
        hostUserId: "host-1",
        hostLedgerEntryId: "hl-vc2",
        hostPointsCredited: 100_000n,
        hostTxType: PointTxType.VIDEO_CALL,
        day,
      },
      tx as never,
    );

    const opts = creditInTransaction.mock.calls[0]![4] as { metadata: Record<string, unknown> };
    expect(opts.metadata).toMatchObject({
      category: "MATCH_CHAT",
      hostTxType: PointTxType.VIDEO_CALL,
    });
    expect(opts.metadata).not.toHaveProperty("giftId");
    expect(opts.metadata).not.toHaveProperty("senderUserId");
  });
});

describe("giftFieldsFromHostLedger", () => {
  it("returns gift fields + senderUserId from host GIFT_RECEIVE row", () => {
    expect(
      giftFieldsFromHostLedger({
        counterpartyId: "sender-9",
        metadata: {
          giftId: "g1",
          giftName: "Heart",
          context: "livestream",
          quantity: 1,
          unitCoinCost: 50,
        },
      }),
    ).toEqual({
      giftId: "g1",
      giftName: "Heart",
      context: "livestream",
      quantity: 1,
      unitCoinCost: 50,
      senderUserId: "sender-9",
    });
  });

  it("returns null when giftId missing", () => {
    expect(
      giftFieldsFromHostLedger({
        counterpartyId: "sender-9",
        metadata: { context: "direct" },
      }),
    ).toBeNull();
  });
});
