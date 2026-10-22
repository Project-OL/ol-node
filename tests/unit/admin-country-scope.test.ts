import { describe, it, expect, vi, beforeEach } from 'vitest'

// F05: country-restricted admins reach only users of their granted countries.

const U_NP = '11111111-1111-4111-8111-111111111111' // Nepal
const U_IN = '22222222-2222-4222-8222-222222222222' // India
const W_NP = '33333333-3333-4333-8333-333333333333'
const W_IN = '44444444-4444-4444-8444-444444444444'
const E_1 = '55555555-5555-4555-8555-555555555555'
const G_1 = '66666666-6666-4666-8666-666666666666'
const T_1 = '77777777-7777-4777-8777-777777777777'

const countries: Record<string, string | null> = { [U_NP]: 'Nepal', [U_IN]: 'India' }
let granted: string[] = ['Nepal']

vi.mock('../../src/config/database', () => ({
  prisma: {},
  prismaRead: {
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => id in countries).map((id) => ({ id, country: countries[id] })),
      ),
      findFirst: vi.fn(async () => ({ id: U_IN })), // numeric public id 123 -> India user
    },
    agency: { findUnique: vi.fn(async () => ({ userId: U_IN })) },
    withdrawal: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === W_NP ? { userId: U_NP } : where.id === W_IN ? { userId: U_IN } : null,
      ),
    },
    withdrawalPayrollAssignment: {
      findUnique: vi.fn(async () => ({ agencyUserId: U_NP, withdrawal: { userId: U_IN } })),
    },
    coinLedgerEntry: {
      findUnique: vi.fn(async () => ({ counterpartyId: null, wallet: { userId: U_NP } })),
    },
    pointLedgerEntry: {
      findUnique: vi.fn(async () => ({ counterpartyId: U_IN, wallet: { userId: U_NP } })),
    },
    giftTransaction: {
      findUnique: vi.fn(async () => ({ senderUserId: U_NP, receiverUserId: U_NP })),
    },
    coinTradingTransfer: {
      findUnique: vi.fn(async () => ({ senderAgentUserId: U_NP, recipientUserId: U_IN })),
    },
  },
}))

vi.mock('../../src/services/adminCountryAccess.service', async () => {
  const { AppError } = await import('../../src/middlewares/errorHandler')
  return {
    adminCountryAccessService: {
      getAccessSnapshot: vi.fn(async () => ({
        restricted: granted.length > 0,
        countries: new Set(granted),
      })),
      assertAllowed: vi.fn(async (_a: string, role: string, c: string | null) => {
        if (role === 'SUPER_ADMIN' || !granted.length) return
        if (!c || !granted.includes(c)) {
          throw new AppError(403, 'no', 'COUNTRY_ACCESS_FORBIDDEN')
        }
      }),
    },
  }
})

import { adminCountryScopeService, resolveRouteUsers } from '../../src/services/adminCountryScope.service'

const enforce = (route: string, params: Record<string, string>, role = 'CUSTOMER_SUPPORT') =>
  adminCountryScopeService.enforce('admin-1', role as never, route, params)
const forbidden = { statusCode: 403, code: 'COUNTRY_ACCESS_FORBIDDEN' }

beforeEach(() => {
  granted = ['Nepal']
})

describe('F05 admin country scope', () => {
  it('user routes (wallet, KYC, contact): own country passes, other country is 403', async () => {
    await expect(enforce('/admin/users/:userId/wallet', { userId: U_NP })).resolves.toBeUndefined()
    await expect(enforce('/admin/users/:userId/wallet', { userId: U_IN })).rejects.toMatchObject(forbidden)
    await expect(enforce('/admin/users/:userId/kyc-contact', { userId: U_IN })).rejects.toMatchObject(forbidden)
    await expect(
      enforce('/admin/agency/users/:userId/wallet/credit', { userId: U_IN }),
    ).rejects.toMatchObject(forbidden)
    // numeric public id resolves to the India user
    await expect(enforce('/admin/users/:userId', { userId: '123' })).rejects.toMatchObject(forbidden)
  })

  it('withdrawal and payroll routes check the host (and the agent)', async () => {
    await expect(enforce('/admin/agency/withdrawal/:id', { id: W_NP })).resolves.toBeUndefined()
    await expect(enforce('/admin/agency/withdrawal/:id/reverse', { id: W_IN })).rejects.toMatchObject(forbidden)
    await expect(
      enforce('/admin/agency/payroll/assignments/:assignmentId', { assignmentId: E_1 }),
    ).rejects.toMatchObject(forbidden)
  })

  it('transaction reverts check every user the entry moves money between', async () => {
    await expect(
      enforce('/admin/transactions/coins/:ledgerEntryId/revert', { ledgerEntryId: E_1 }),
    ).resolves.toBeUndefined()
    await expect(
      enforce('/admin/transactions/points/:ledgerEntryId/revert', { ledgerEntryId: E_1 }),
    ).rejects.toMatchObject(forbidden)
    await expect(
      enforce('/admin/transactions/gifts/:giftTransactionId/revert', { giftTransactionId: G_1 }),
    ).resolves.toBeUndefined()
    await expect(
      enforce('/admin/transactions/coin-trading-transfers/:transferId/revert', { transferId: T_1 }),
    ).rejects.toMatchObject(forbidden)
  })

  it('agency KYC contact checks the agency owner', async () => {
    await expect(
      enforce('/admin/agency/:agencyIdentifier/kyc-contact', { agencyIdentifier: '10000001' }),
    ).rejects.toMatchObject(forbidden)
  })

  it('global money / personal-data lists are refused; other routes pass', async () => {
    for (const r of [
      '/admin/transactions/coins',
      '/admin/transactions/points',
      '/admin/ledger/house-accounts',
      '/admin/agency/payroll/pending-platform',
      '/admin/users/search',
      '/admin/users/stats',
    ]) {
      await expect(enforce(r, {}), r).rejects.toMatchObject(forbidden)
    }
    await expect(enforce('/admin/users/country-search', {})).resolves.toBeUndefined()
    await expect(enforce('/admin/country-access/me', {})).resolves.toBeUndefined()
    await expect(enforce('/admin/gifts', {})).resolves.toBeUndefined()
  })

  it('SUPER_ADMIN and admins with no grants are unaffected', async () => {
    await expect(enforce('/admin/users/:userId/wallet', { userId: U_IN }, 'SUPER_ADMIN')).resolves.toBeUndefined()
    await expect(enforce('/admin/transactions/coins', {}, 'SUPER_ADMIN')).resolves.toBeUndefined()
    granted = []
    await expect(enforce('/admin/users/:userId/wallet', { userId: U_IN })).resolves.toBeUndefined()
    await expect(enforce('/admin/transactions/coins', {})).resolves.toBeUndefined()
  })

  it('an id that resolves to nothing passes through to the handler (its 404)', async () => {
    await expect(
      enforce('/admin/agency/withdrawal/:id', { id: '99999999-9999-4999-8999-999999999999' }),
    ).resolves.toBeUndefined()
    expect(await resolveRouteUsers('/admin/agency/withdrawal/:id', { id: 'not-a-uuid' })).toEqual([])
    expect(await resolveRouteUsers('/admin/gifts', {})).toBeNull()
  })
})
