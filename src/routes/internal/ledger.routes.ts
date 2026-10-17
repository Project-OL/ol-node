import type { FastifyInstance } from 'fastify'
import {
  CallAcceptSchema,
  CallMinuteSchema,
  GiftSendSchema,
  GlobalMessageSchema,
  LuckyGiftSchema,
} from '../../models/internal-ledger.schemas'
import { internalLedgerService } from '../../services/internalLedger.service'

/**
 * BE-20 internal ledger API, called only by Live-server. Registered on the internal listener
 * (src/internal/internal-app.ts), which verifies the HMAC signature before any handler runs.
 * Docs: docs/flow-md/internal-ledger-flow.md.
 */
export async function internalLedgerRoutes(app: FastifyInstance) {
  app.post('/gift', async (req) => internalLedgerService.giftSend(GiftSendSchema.parse(req.body)))
  app.post('/lucky-gift', async (req) =>
    internalLedgerService.luckyGiftSend(LuckyGiftSchema.parse(req.body)),
  )
  app.post('/call-accept', async (req) =>
    internalLedgerService.callAccept(CallAcceptSchema.parse(req.body)),
  )
  app.post('/call-minute', async (req) =>
    internalLedgerService.callMinute(CallMinuteSchema.parse(req.body)),
  )
  app.post('/global-message', async (req) =>
    internalLedgerService.globalMessage(GlobalMessageSchema.parse(req.body)),
  )
}
