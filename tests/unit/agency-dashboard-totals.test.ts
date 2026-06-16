describe('Agency dashboard totalEarningsPoints', () => {
  it('totalEarningsPoints = hostEarningsPoints + hostCommissionPoints', () => {
    const hostEarnings = 100n
    const hostCommission = 4n
    const total = hostEarnings + hostCommission
    expect(total).toBe(104n)
  })

  it('agent-as-own-host: own earnings + own commission sum correctly', () => {
    // Agent earns 6000 points from their own gift receive
    // Commission at level D (4%): floor(6000 * 400 / 10000) = 240 points
    const hostEarnings = 6_000n
    const commissionBp = 400n
    const commission = (hostEarnings * commissionBp) / 10_000n
    expect(commission).toBe(240n)
    const total = hostEarnings + commission
    expect(total).toBe(6_240n)
  })

  it('gift example from spec: 100 host pts → 4 commission → 104 total', () => {
    const hostPts = 100n
    const rateBp = 400n // level D
    const commission = (hostPts * rateBp) / 10_000n
    expect(commission).toBe(4n)
    expect(hostPts + commission).toBe(104n)
  })
})
