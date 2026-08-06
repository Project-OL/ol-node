import { supportRepository } from '../repositories/support.repository'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { userRepository } from '../repositories/user.repository'
import { csaNotificationService } from './csaNotification.service'

/**
 * Auto-assignment for support tickets.
 *
 * Routing rules:
 * 1. Candidates = ACTIVE admins with role CUSTOMER_SUPPORT (minus excludeAdminId).
 * 2. Prefer CSAs whose country matches the ticket owner's country (case-insensitive).
 *    When none match, all candidates are eligible.
 * 3. Pick the candidate with the lowest open (non-CLOSED) assigned-ticket count;
 *    ties break on lowest admin id for determinism.
 *
 * Concurrency note: two simultaneous ticket creates may both pick the same
 * least-loaded CSA — an accepted off-by-one that self-corrects on the next
 * assignment; no lock is taken.
 */
export const supportAssignmentService = {
  /**
   * Assign a ticket to the best-matching CSA. Returns the chosen admin id, or
   * null when no ACTIVE CSA exists (the ticket stays in the unassigned OPEN queue).
   * Never throws on assignment failure paths that should not break ticket creation —
   * callers on the create path wrap this in try/catch anyway.
   */
  async assignTicket(
    ticketId: bigint,
    opts?: { excludeAdminId?: string },
  ): Promise<string | null> {
    const ticket = await supportRepository.findTicketById(ticketId)
    if (!ticket || ticket.status === 'CLOSED' || ticket.status === 'PENDING_REVIEW') return null
    if (ticket.rating != null) return null

    const candidates = (await systemAdminRepository.findAllByRole('CUSTOMER_SUPPORT', 'ACTIVE')).filter(
      (a) => a.id !== opts?.excludeAdminId,
    )
    if (candidates.length === 0) return null

    const owner = await userRepository.findById(ticket.userId)
    const ownerCountry = owner?.country?.trim().toLowerCase() ?? null

    let pool = candidates
    if (ownerCountry) {
      const sameCountry = candidates.filter(
        (a) => a.country && a.country.trim().toLowerCase() === ownerCountry,
      )
      if (sameCountry.length > 0) pool = sameCountry
    }

    const loads = await supportRepository.countOpenByAdminIds(pool.map((a) => a.id))
    pool = [...pool].sort((a, b) => {
      const loadDiff = (loads.get(a.id) ?? 0) - (loads.get(b.id) ?? 0)
      if (loadDiff !== 0) return loadDiff
      return a.id < b.id ? -1 : 1
    })
    const chosen = pool[0]

    // On the create path an unassigned ticket moves OPEN → ASSIGNED; on
    // reassignment the current status is preserved (only ownership changes).
    const wasUnassigned = !ticket.assignedAdminId
    await supportRepository.assignTicket(ticketId, chosen.id, {
      setStatusAssigned: wasUnassigned && (ticket.status === 'OPEN' || ticket.status === 'AWAITING_REPLY'),
    })

    await csaNotificationService.notify(
      chosen.id,
      wasUnassigned ? 'TICKET_ASSIGNED' : 'TICKET_REASSIGNED',
      `Ticket ${ticket.publicId} (${ticket.type}/${ticket.subType}) assigned to you`,
      { ticketId },
    )

    return chosen.id
  },

  /**
   * Reassign every open ticket held by an admin (used when a CSA is disabled
   * or suspended). PENDING_REVIEW tickets are **not** moved — assignee is
   * frozen through the 24h review window so star ratings stay attributed to
   * the resolving CSA. Other tickets with no available candidate return to
   * the unassigned OPEN queue.
   */
  async reassignAllFrom(adminId: string): Promise<{ reassigned: number; unassigned: number }> {
    const tickets = await supportRepository.findActiveTicketsByAdmin(adminId)
    let reassigned = 0
    let unassigned = 0

    for (const ticket of tickets) {
      if (ticket.status === 'PENDING_REVIEW') {
        // Keep assignee for rating attribution; auto-close still fires.
        continue
      }
      const newAdminId = await this.assignTicket(ticket.id, { excludeAdminId: adminId })
      if (newAdminId) {
        reassigned += 1
        continue
      }
      unassigned += 1
      await supportRepository.updateTicketStatus(ticket.id, 'OPEN', {
        assignedAdminId: null,
        assignedAt: null,
      })
    }

    return { reassigned, unassigned }
  },
}
