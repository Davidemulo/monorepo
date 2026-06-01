import { beforeEach, describe, expect, it } from 'vitest'
import { creditScoreService } from './creditScoreService.js'
import { creditScoreSnapshotStore } from '../models/creditScoreSnapshot.js'

describe('CreditScoreService', () => {
  beforeEach(async () => {
    await creditScoreSnapshotStore.clear()
  })

  it('returns the latest snapshot and limits history to 12 items', async () => {
    await creditScoreService.recordSnapshot({
      userId: 'tenant-1',
      score: 42,
      computedAt: new Date('2026-01-01T00:00:00.000Z'),
      factors: [
        { name: 'deposit_minimum', status: 'fail', weight: 20, detail: 'Deposit ratio below minimum' },
      ],
    })

    await creditScoreService.recordSnapshot({
      userId: 'tenant-1',
      score: 88,
      computedAt: new Date('2026-02-01T00:00:00.000Z'),
      factors: [
        { name: 'employment_verified', status: 'warn', weight: 25, detail: 'No employment verification data' },
        { name: 'no_overdrafts', status: 'fail', weight: 15, detail: '2 overdrafts detected' },
        { name: 'payment_history_good', status: 'warn', weight: 20, detail: 'No payment history available' },
      ],
    })

    const latest = await creditScoreService.getLatestSnapshot('tenant-1')
    expect(latest?.score).toBe(88)
    expect(latest?.band).toBe('excellent')

    const history = await creditScoreService.getHistory('tenant-1')
    expect(history).toHaveLength(2)

    for (let index = 0; index < 11; index += 1) {
      await creditScoreService.recordSnapshot({
        userId: 'tenant-1',
        score: 30 + index,
        computedAt: new Date(`2026-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
        factors: [
          { name: 'income_sufficient', status: 'warn', weight: 25, detail: 'Income evidence is incomplete' },
        ],
      })
    }

    const limitedHistory = await creditScoreService.getHistory('tenant-1')
    expect(limitedHistory).toHaveLength(12)
  })

  it('generates actionable tips from the worst factors first', () => {
    const tips = creditScoreService.generateImprovementTips({
      id: 'snapshot-1',
      userId: 'tenant-1',
      score: 50,
      band: 'fair',
      computedAt: new Date(),
      factors: [
        { name: 'employment_verified', status: 'warn', weight: 25, detail: 'No employment verification data' },
        { name: 'no_overdrafts', status: 'fail', weight: 15, detail: '2 overdrafts detected' },
        { name: 'payment_history_good', status: 'warn', weight: 20, detail: 'No payment history available' },
        { name: 'deposit_minimum', status: 'pass', weight: 20, detail: 'Deposit ratio meets minimum' },
      ],
    })

    expect(tips).toEqual([
      'Avoid overdrafts and returned payments on linked accounts.',
      'Upload employment verification or a recent employment letter.',
      'Keep your on-time payment rate above 90%.',
    ])
  })
})