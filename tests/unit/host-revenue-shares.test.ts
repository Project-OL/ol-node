import { describe, expect, it } from 'vitest'
import {
  hostPointsFromGift,
  hostPointsFromSubscription,
  hostPointsFromGuardian,
  callerCoinDebitForCall,
} from '../../src/config/host-revenue-shares'

describe('hostPointsFromGift', () => {
  it('returns 60% of coin cost', () => {
    expect(hostPointsFromGift(10_000n)).toBe(6_000n)
    expect(hostPointsFromGift(1n)).toBe(0n) // floor
  })
})

describe('hostPointsFromSubscription', () => {
  it('returns 75% of 50,000 = 37,500', () => {
    expect(hostPointsFromSubscription(50_000n)).toBe(37_500n)
  })
})

describe('hostPointsFromGuardian', () => {
  it('SILVER: 150,000 coins → 112,500 points', () => {
    expect(hostPointsFromGuardian(150_000n)).toBe(112_500n)
  })
  it('GOLD: 300,000 coins → 225,000 points', () => {
    expect(hostPointsFromGuardian(300_000n)).toBe(225_000n)
  })
  it('KING: 1,500,000 coins → 1,125,000 points', () => {
    expect(hostPointsFromGuardian(1_500_000n)).toBe(1_125_000n)
  })
})

describe('callerCoinDebitForCall', () => {
  it('host sets 1800 pts/min → caller pays 3000 coins', () => {
    expect(callerCoinDebitForCall(1_800n)).toBe(3_000n)
  })
  it('host sets 3000 pts/min → caller pays 5000 coins', () => {
    expect(callerCoinDebitForCall(3_000n)).toBe(5_000n)
  })
  it('host sets 1000 pts/min → caller pays ceil(1666.67) = 1667 coins', () => {
    expect(callerCoinDebitForCall(1_000n)).toBe(1_667n)
  })
  it('host receives exactly their set price as points', () => {
    const hostPrice = 2_400n
    const callerPays = callerCoinDebitForCall(hostPrice)
    const hostGets = (callerPays * 6_000n) / 10_000n
    expect(hostGets).toBe(hostPrice)
  })
})
