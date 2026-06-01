import {
  bandFromScore,
  creditScoreSnapshotStore,
  type CreditScoreFactor,
  type CreditScoreSnapshot,
} from '../models/creditScoreSnapshot.js'

const IMPROVEMENT_TIPS: Record<string, string> = {
  deposit_minimum: 'Increase your deposit to at least 20% of annual rent.',
  deposit_adequate: 'Aim for a larger deposit to strengthen your application.',
  duration_reasonable: 'Choose a shorter lease term, ideally 12 months or less.',
  monthly_payment_affordable: 'Reduce your monthly payment so it stays within affordability limits.',
  user_not_frozen: 'Resolve any account freeze issues and provide supporting documents.',
  payment_history_good: 'Keep your on-time payment rate above 90%.',
  no_missed_payments: 'Avoid missed payments and clear any arrears.',
  employment_verified: 'Upload employment verification or a recent employment letter.',
  income_stable: 'Provide evidence of stable income over several months.',
  income_sufficient: 'Increase verified income or reduce rent obligations.',
  no_overdrafts: 'Avoid overdrafts and returned payments on linked accounts.',
}

function severityRank(status: CreditScoreFactor['status']): number {
  if (status === 'fail') return 0
  if (status === 'warn') return 1
  return 2
}

function scoreToBand(score: number) {
  return bandFromScore(score)
}

function improvementTipForFactor(factor: CreditScoreFactor): string {
  return IMPROVEMENT_TIPS[factor.name] ?? `Improve ${factor.name.replaceAll('_', ' ')} using the details in your score breakdown.`
}

export class CreditScoreService {
  async recordSnapshot(input: {
    userId: string
    score: number
    factors: CreditScoreFactor[]
    computedAt?: Date
  }): Promise<CreditScoreSnapshot> {
    return creditScoreSnapshotStore.create({
      userId: input.userId,
      score: input.score,
      band: scoreToBand(input.score),
      factors: input.factors,
      computedAt: input.computedAt,
    })
  }

  async getLatestSnapshot(tenantId: string): Promise<CreditScoreSnapshot | null> {
    return creditScoreSnapshotStore.getLatestByUserId(tenantId)
  }

  async getHistory(tenantId: string): Promise<CreditScoreSnapshot[]> {
    return creditScoreSnapshotStore.listByUserId(tenantId, 12)
  }

  generateImprovementTips(snapshot: CreditScoreSnapshot): string[] {
    return snapshot.factors
      .filter((factor) => factor.status !== 'pass')
      .sort((a, b) => severityRank(a.status) - severityRank(b.status) || b.weight - a.weight)
      .slice(0, 3)
      .map((factor) => improvementTipForFactor(factor))
  }
}

export const creditScoreService = new CreditScoreService()