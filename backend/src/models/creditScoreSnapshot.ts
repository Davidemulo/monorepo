import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'

export type CreditScoreBand = 'poor' | 'fair' | 'good' | 'excellent'
export type CreditFactorStatus = 'pass' | 'fail' | 'warn'

export interface CreditScoreFactor {
  name: string
  status: CreditFactorStatus
  weight: number
  detail: string
}

export interface CreditScoreSnapshot {
  id: string
  userId: string
  score: number
  band: CreditScoreBand
  factors: CreditScoreFactor[]
  computedAt: Date
}

export interface CreateCreditScoreSnapshotInput {
  userId: string
  score: number
  band: CreditScoreBand
  factors: CreditScoreFactor[]
  computedAt?: Date
}

export interface CreditScoreSnapshotStore {
  create(input: CreateCreditScoreSnapshotInput): Promise<CreditScoreSnapshot>
  getLatestByUserId(userId: string): Promise<CreditScoreSnapshot | null>
  listByUserId(userId: string, limit?: number): Promise<CreditScoreSnapshot[]>
  clear(): Promise<void>
}

export function bandFromScore(score: number): CreditScoreBand {
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  if (score >= 40) return 'fair'
  return 'poor'
}

export class InMemoryCreditScoreSnapshotStore implements CreditScoreSnapshotStore {
  private snapshots: CreditScoreSnapshot[] = []

  async create(input: CreateCreditScoreSnapshotInput): Promise<CreditScoreSnapshot> {
    const snapshot: CreditScoreSnapshot = {
      id: randomUUID(),
      userId: input.userId,
      score: input.score,
      band: input.band,
      factors: input.factors,
      computedAt: input.computedAt ?? new Date(),
    }

    this.snapshots.push(snapshot)
    return snapshot
  }

  async getLatestByUserId(userId: string): Promise<CreditScoreSnapshot | null> {
    const snapshots = this.snapshots
      .filter((snapshot) => snapshot.userId === userId)
      .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())

    return snapshots[0] ?? null
  }

  async listByUserId(userId: string, limit = 12): Promise<CreditScoreSnapshot[]> {
    return this.snapshots
      .filter((snapshot) => snapshot.userId === userId)
      .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())
      .slice(0, limit)
  }

  async clear(): Promise<void> {
    this.snapshots = []
  }
}

export class PostgresCreditScoreSnapshotStore implements CreditScoreSnapshotStore {
  async create(input: CreateCreditScoreSnapshotInput): Promise<CreditScoreSnapshot> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')

    const computedAt = input.computedAt ?? new Date()
    const id = randomUUID()

    const result = await pool.query(
      `INSERT INTO credit_score_snapshots (
        id, user_id, score, band, factors, computed_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, score, band, factors, computed_at`,
      [id, input.userId, input.score, input.band, JSON.stringify(input.factors), computedAt],
    )

    return this.mapRow(result.rows[0])
  }

  async getLatestByUserId(userId: string): Promise<CreditScoreSnapshot | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')

    const result = await pool.query(
      `SELECT id, user_id, score, band, factors, computed_at
       FROM credit_score_snapshots
       WHERE user_id = $1
       ORDER BY computed_at DESC
       LIMIT 1`,
      [userId],
    )

    if (result.rows.length === 0) {
      return null
    }

    return this.mapRow(result.rows[0])
  }

  async listByUserId(userId: string, limit = 12): Promise<CreditScoreSnapshot[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')

    const result = await pool.query(
      `SELECT id, user_id, score, band, factors, computed_at
       FROM credit_score_snapshots
       WHERE user_id = $1
       ORDER BY computed_at DESC
       LIMIT $2`,
      [userId, limit],
    )

    return result.rows.map(this.mapRow)
  }

  async clear(): Promise<void> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    await pool.query('DELETE FROM credit_score_snapshots')
  }

  private mapRow(row: any): CreditScoreSnapshot {
    return {
      id: row.id,
      userId: row.user_id,
      score: row.score,
      band: row.band,
      factors: row.factors,
      computedAt: new Date(row.computed_at),
    }
  }
}

let creditScoreSnapshotStore: CreditScoreSnapshotStore = new InMemoryCreditScoreSnapshotStore()

export function initCreditScoreSnapshotStore(store: CreditScoreSnapshotStore): void {
  creditScoreSnapshotStore = store
}

export { creditScoreSnapshotStore }