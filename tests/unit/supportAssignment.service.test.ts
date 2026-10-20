import { describe, it, expect, vi, beforeEach } from 'vitest'

const findTicketById = vi.fn()
const countOpenByAdminIds = vi.fn()
const assignTicket = vi.fn()
const findActiveTicketsByAdmin = vi.fn()
const updateTicketStatus = vi.fn()
vi.mock('../../src/repositories/support.repository', () => ({
  supportRepository: {
    findTicketById: (...a: unknown[]) => findTicketById(...a),
    countOpenByAdminIds: (...a: unknown[]) => countOpenByAdminIds(...a),
    assignTicket: (...a: unknown[]) => assignTicket(...a),
    findActiveTicketsByAdmin: (...a: unknown[]) => findActiveTicketsByAdmin(...a),
    updateTicketStatus: (...a: unknown[]) => updateTicketStatus(...a),
  },
}))

const findAllByRole = vi.fn()
vi.mock('../../src/repositories/systemAdmin.repository', () => ({
  systemAdminRepository: {
    findAllByRole: (...a: unknown[]) => findAllByRole(...a),
  },
}))

const findUserById = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...a: unknown[]) => findUserById(...a),
  },
}))

const notify = vi.fn()
vi.mock('../../src/services/csaNotification.service', () => ({
  csaNotificationService: {
    notify: (...a: unknown[]) => notify(...a),
  },
}))

const { supportAssignmentService } = await import('../../src/services/supportAssignment.service')

const ticketId = 42n
const baseTicket = {
  id: ticketId,
  publicId: 'tkt_1',
  userId: 'user-1',
  type: 'REPORT_COMPLAINTS',
  subType: 'GIFT_FRAUD',
  status: 'OPEN',
  assignedAdminId: null,
}

const csa = (id: string, country: string, autoAssignEnabled = true) => ({
  id,
  role: 'CUSTOMER_SUPPORT',
  status: 'ACTIVE',
  country,
  autoAssignEnabled,
})
const csaIndia = csa('a-india', 'India')
const csaIndia2 = csa('b-india', 'india')
const csaBrazil = csa('c-brazil', 'Brazil')

beforeEach(() => {
  vi.clearAllMocks()
  findTicketById.mockResolvedValue({ ...baseTicket })
  findUserById.mockResolvedValue({ id: 'user-1', country: 'India' })
  countOpenByAdminIds.mockResolvedValue(new Map())
  assignTicket.mockResolvedValue({ ...baseTicket, assignedAdminId: 'x' })
  notify.mockResolvedValue(undefined)
})

describe('supportAssignmentService.assignTicket', () => {
  it('prefers a same-country CSA (case-insensitive)', async () => {
    findAllByRole.mockResolvedValue([csaBrazil, csaIndia2])
    const chosen = await supportAssignmentService.assignTicket(ticketId)
    expect(chosen).toBe('b-india')
    expect(assignTicket).toHaveBeenCalledWith(ticketId, 'b-india', { setStatusAssigned: true })
  })

  it('falls back to all ACTIVE CSAs when no country match', async () => {
    findAllByRole.mockResolvedValue([csaBrazil])
    findUserById.mockResolvedValue({ id: 'user-1', country: 'Japan' })
    const chosen = await supportAssignmentService.assignTicket(ticketId)
    expect(chosen).toBe('c-brazil')
  })

  it('picks the lowest open-ticket load; ties break on lowest id', async () => {
    findAllByRole.mockResolvedValue([csaIndia, csaIndia2])
    countOpenByAdminIds.mockResolvedValue(
      new Map([
        ['a-india', 5],
        ['b-india', 2],
      ]),
    )
    expect(await supportAssignmentService.assignTicket(ticketId)).toBe('b-india')

    countOpenByAdminIds.mockResolvedValue(
      new Map([
        ['a-india', 3],
        ['b-india', 3],
      ]),
    )
    expect(await supportAssignmentService.assignTicket(ticketId)).toBe('a-india')
  })

  it('returns null and assigns nothing when no ACTIVE CSA exists', async () => {
    findAllByRole.mockResolvedValue([])
    expect(await supportAssignmentService.assignTicket(ticketId)).toBeNull()
    expect(assignTicket).not.toHaveBeenCalled()
  })

  it('skips CSAs who opted out of auto-assignment', async () => {
    findAllByRole.mockResolvedValue([csa('a-india', 'India', false), csaBrazil])
    expect(await supportAssignmentService.assignTicket(ticketId)).toBe('c-brazil')

    findAllByRole.mockResolvedValue([csa('a-india', 'India', false)])
    expect(await supportAssignmentService.assignTicket(ticketId)).toBeNull()
  })

  it('honors excludeAdminId', async () => {
    findAllByRole.mockResolvedValue([csaIndia, csaIndia2])
    const chosen = await supportAssignmentService.assignTicket(ticketId, {
      excludeAdminId: 'a-india',
    })
    expect(chosen).toBe('b-india')
  })

  it('notifies TICKET_ASSIGNED on first assignment and preserves status on reassignment', async () => {
    findAllByRole.mockResolvedValue([csaIndia])
    await supportAssignmentService.assignTicket(ticketId)
    expect(notify).toHaveBeenCalledWith('a-india', 'TICKET_ASSIGNED', expect.any(String), {
      ticketId,
    })

    notify.mockClear()
    findTicketById.mockResolvedValue({
      ...baseTicket,
      status: 'AWAITING_REPLY',
      assignedAdminId: 'old-admin',
    })
    await supportAssignmentService.assignTicket(ticketId, { excludeAdminId: 'old-admin' })
    expect(assignTicket).toHaveBeenLastCalledWith(ticketId, 'a-india', { setStatusAssigned: false })
    expect(notify).toHaveBeenCalledWith('a-india', 'TICKET_REASSIGNED', expect.any(String), {
      ticketId,
    })
  })

  it('does nothing for CLOSED or missing tickets', async () => {
    findTicketById.mockResolvedValue({ ...baseTicket, status: 'CLOSED' })
    expect(await supportAssignmentService.assignTicket(ticketId)).toBeNull()
    findTicketById.mockResolvedValue(null)
    expect(await supportAssignmentService.assignTicket(ticketId)).toBeNull()
  })
})

describe('supportAssignmentService.reassignAllFrom', () => {
  it('reassigns each non-PENDING_REVIEW ticket; falls back to unassigned OPEN; PENDING_REVIEW is left untouched', async () => {
    // PENDING_REVIEW tickets are skipped entirely (not reassigned, not force-
    // unassigned) to keep the original assignee attributed for the pending
    // customer rating — see the "Keep assignee for rating attribution" comment
    // in supportAssignment.service.ts's reassignAllFrom.
    findActiveTicketsByAdmin.mockResolvedValue([
      { ...baseTicket, id: 1n, status: 'ASSIGNED', assignedAdminId: 'gone' },
      { ...baseTicket, id: 2n, status: 'PENDING_REVIEW', assignedAdminId: 'gone' },
    ])
    // No candidates at all → the non-PENDING_REVIEW ticket goes to the unassigned queue.
    findAllByRole.mockResolvedValue([])
    findTicketById.mockImplementation(async (id: bigint) => ({
      ...baseTicket,
      id,
      status: id === 2n ? 'PENDING_REVIEW' : 'ASSIGNED',
      assignedAdminId: 'gone',
    }))

    const result = await supportAssignmentService.reassignAllFrom('gone')

    expect(result).toEqual({ reassigned: 0, unassigned: 1 })
    expect(updateTicketStatus).toHaveBeenCalledWith(1n, 'OPEN', {
      assignedAdminId: null,
      assignedAt: null,
    })
    expect(updateTicketStatus).not.toHaveBeenCalledWith(2n, expect.anything(), expect.anything())
  })

  it('counts successful reassignments', async () => {
    findActiveTicketsByAdmin.mockResolvedValue([
      { ...baseTicket, id: 1n, status: 'ASSIGNED', assignedAdminId: 'gone' },
    ])
    findAllByRole.mockResolvedValue([csaIndia])
    findTicketById.mockResolvedValue({
      ...baseTicket,
      id: 1n,
      status: 'ASSIGNED',
      assignedAdminId: 'gone',
    })

    const result = await supportAssignmentService.reassignAllFrom('gone')
    expect(result).toEqual({ reassigned: 1, unassigned: 0 })
  })
})
