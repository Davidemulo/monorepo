import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next()
  },
}))

import { createAdminCreditScoreRouter, createCreditScoreRouter } from './creditScore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { creditScoreService } from '../services/creditScoreService.js'
import { creditScoreSnapshotStore } from '../models/creditScoreSnapshot.js'

describe('credit score routes', () => {
  beforeEach(async () => {
    await creditScoreSnapshotStore.clear()
  })

  function buildApp(role: 'tenant' | 'admin', userId: string) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string; role: string; email: string; name: string } }).user = {
        id: userId,
        role,
        email: `${userId}@example.com`,
        name: userId,
      }
      next()
    })
    app.use('/api/credit-score', createCreditScoreRouter())
    app.use('/api/admin', createAdminCreditScoreRouter())
    app.use(errorHandler)
    return app
  }

  it('returns the current snapshot for the tenant', async () => {
    await creditScoreService.recordSnapshot({
      userId: 'tenant-a',
      score: 74,
      factors: [
        { name: 'income_stable', status: 'warn', weight: 20, detail: 'No income stability data - treated as neutral' },
        { name: 'employment_verified', status: 'fail', weight: 25, detail: 'Employment verification failed' },
      ],
    })

    const res = await request(buildApp('tenant', 'tenant-a')).get('/api/credit-score/my')
    expect(res.status).toBe(200)
    expect(res.body.score).toBe(74)
    expect(res.body.band).toBe('fair')
    expect(res.body.factors).toHaveLength(2)
    expect(res.body.tips).toHaveLength(2)
    expect(res.body.computedAt).toBeDefined()
  })

  it('returns NO_SCORE_YET when the tenant has no snapshot', async () => {
    const res = await request(buildApp('tenant', 'tenant-b')).get('/api/credit-score/my')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NO_SCORE_YET')
  })

  it('returns history for the tenant', async () => {
    await creditScoreService.recordSnapshot({
      userId: 'tenant-a',
      score: 41,
      factors: [
        { name: 'payment_history_good', status: 'warn', weight: 20, detail: 'No payment history available' },
      ],
    })
    await creditScoreService.recordSnapshot({
      userId: 'tenant-a',
      score: 62,
      factors: [
        { name: 'deposit_minimum', status: 'pass', weight: 20, detail: 'Deposit ratio meets minimum' },
      ],
    })

    const res = await request(buildApp('tenant', 'tenant-a')).get('/api/credit-score/my/history')
    expect(res.status).toBe(200)
    expect(res.body.snapshots).toHaveLength(2)
    expect(res.body.snapshots[0].score).toBe(62)
  })

  it('returns the full factor payload for admins', async () => {
    await creditScoreService.recordSnapshot({
      userId: 'tenant-a',
      score: 88,
      factors: [
        { name: 'no_overdrafts', status: 'pass', weight: 15, detail: 'No overdrafts detected' },
      ],
    })

    const res = await request(buildApp('admin', 'admin-1')).get('/api/admin/credit-score/tenant-a')
    expect(res.status).toBe(200)
    expect(res.body.tenantId).toBe('tenant-a')
    expect(res.body.factors).toHaveLength(1)
  })
})