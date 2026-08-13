import type { Prisma } from '@prisma/client'
import { walletRepository } from '../repositories/wallet.repository'

/**
 * Lock wallets in a deterministic id order so crossed transfers cannot deadlock.
 * Callers must pass every wallet row the transaction will touch.
 */
export async function lockWalletsInOrder(
  tx: Prisma.TransactionClient,
  wallets: Array<{ id: string }>,
): Promise<void> {
  const seen = new Set<string>()
  const ordered = wallets
    .filter((w) => {
      if (seen.has(w.id)) return false
      seen.add(w.id)
      return true
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const w of ordered) {
    await walletRepository.lockForUpdate(tx, w.id)
  }
}
