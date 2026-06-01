/**
 * Underwriting Service
 * Orchestrates the underwriting evaluation process for tenant applications
 */

import {
  UnderwritingRuleEngine,
  UnderwritingContext,
  UnderwritingResult,
  UnderwritingDecision,
  DEFAULT_RULE_CONFIG,
} from "./underwritingRuleEngine.js";
import { tenantApplicationStore } from "../models/tenantApplicationStore.js";
import { userRiskStateStore } from "../models/userRiskStateStore.js";
import { underwritingDecisionTraceStore } from "../models/underwritingDecisionTraceStore.js";
import {
  tenantCreditScoringService,
  TenantCreditScoringService,
} from "./tenantCreditScoringService.js";
import { decisionFromCreditBand } from "../models/tenantCreditScore.js";
import { creditBureauService } from "./creditBureauService.js";
import type { TenantCreditScore } from "../models/tenantCreditScore.js";
import {
  AiRiskScoringService,
  aiRiskScoringService,
} from "./aiRiskScoringService.js";
import type { AiRiskScoreResult } from "./aiRiskScoreProvider.js";
import { creditScoreService } from './creditScoreService.js';
import type { CreditScoreFactor } from '../models/creditScoreSnapshot.js';

export interface UnderwritingEvaluationInput {
  applicationId: string;
  paymentHistory?: {
    onTimePaymentRate: number;
    missedPayments: number;
    totalPayments: number;
  };
  backgroundCheckData?: {
    employmentVerified?: boolean;
    incomeStability?: "stable" | "variable" | "unstable";
    averageMonthlyIncome?: number;
    overdraftCount?: number;
  };
  metadata?: Record<string, any>;
}

export interface UnderwritingEvaluationOutput {
  applicationId: string;
  userId: string;
  decision: UnderwritingDecision;
  result: UnderwritingResult;
  creditScore?: TenantCreditScore;
  creditBandDecision?: string;
  externalCreditScore?: number;
  aiRiskScore?: AiRiskScoreResult;
  evaluatedAt: string;
}

/**
 * Underwriting Service
 * Evaluates tenant applications using the rule engine
 */
function creditBandToUnderwritingDecision(
  bandDecision: ReturnType<typeof decisionFromCreditBand>,
): UnderwritingDecision {
  if (bandDecision === "approve") return "APPROVE";
  if (bandDecision === "manual_review") return "REVIEW";
  return "REJECT";
}

function mergeUnderwritingDecisions(
  credit: UnderwritingDecision,
  rules: UnderwritingDecision,
): UnderwritingDecision {
  const rank: Record<UnderwritingDecision, number> = {
    REJECT: 3,
    REVIEW: 2,
    APPROVE: 1,
  };
  return rank[credit] >= rank[rules] ? credit : rules;
}

export class UnderwritingService {
  private ruleEngine: UnderwritingRuleEngine;
  private creditScoring: TenantCreditScoringService;
  private aiRiskScoring: AiRiskScoringService;

  constructor(
    ruleEngine?: UnderwritingRuleEngine,
    creditScoring?: TenantCreditScoringService,
    aiRiskScoring?: AiRiskScoringService,
  ) {
    this.ruleEngine =
      ruleEngine || new UnderwritingRuleEngine(DEFAULT_RULE_CONFIG);
    this.creditScoring = creditScoring || tenantCreditScoringService;
    this.aiRiskScoring = aiRiskScoring || aiRiskScoringService;
  }

  /**
   * Evaluate a tenant application for underwriting
   */
  async evaluateApplication(
    input: UnderwritingEvaluationInput,
  ): Promise<UnderwritingEvaluationOutput> {
    // Fetch the application
    const application = await tenantApplicationStore.findById(
      input.applicationId,
    );
    if (!application) {
      throw new Error(`Application ${input.applicationId} not found`);
    }

    // Fetch user risk state
    const riskState = await userRiskStateStore.getByUserId(application.userId);

    // Build underwriting context
    const context: UnderwritingContext = {
      userId: application.userId,
      applicationId: application.applicationId,
      annualRent: application.annualRent,
      deposit: application.deposit,
      depositRatio: application.deposit / application.annualRent,
      duration: application.duration,
      monthlyPayment: application.monthlyPayment,
      totalAmount: application.totalAmount,
      userRiskState: riskState
        ? {
            isFrozen: riskState.isFrozen,
            freezeReason: riskState.freezeReason,
          }
        : undefined,
      paymentHistory: input.paymentHistory,
      backgroundCheckData: input.backgroundCheckData,
      metadata: input.metadata,
    };

    // Credit scoring pipeline (onboarding verification data required)
    let creditScore: TenantCreditScore | undefined;
    let creditDecision: UnderwritingDecision | undefined;
    try {
      creditScore = this.creditScoring.computeCompositeScore(
        application.userId,
      );
      creditDecision = creditBandToUnderwritingDecision(
        decisionFromCreditBand(creditScore.band),
      );
    } catch {
      // No onboarding data yet — rule engine only
    }

    const result = this.ruleEngine.evaluate(context);
    const ruleConfig = this.ruleEngine.getConfig();
    const ruleConfigById = new Map(ruleConfig.rules.map((rule) => [rule.ruleId, rule]));
    const scorePercentage = result.maxScore > 0
      ? Math.max(0, Math.min(100, Math.round((result.totalScore / result.maxScore) * 100)))
      : 0;
    const snapshotFactors: CreditScoreFactor[] = result.triggeredRules.map((evaluation) => {
      const rule = ruleConfigById.get(evaluation.ruleId);
      const status = evaluation.passed
        ? (evaluation.score >= evaluation.weight ? 'pass' : 'warn')
        : rule?.severity === 'critical'
          ? 'fail'
          : 'warn';

      return {
        name: evaluation.ruleId,
        status,
        weight: evaluation.weight,
        detail: evaluation.reason,
      };
    });

    await creditScoreService.recordSnapshot({
      userId: application.userId,
      score: scorePercentage,
      factors: snapshotFactors,
      computedAt: new Date(result.evaluatedAt),
    });

    let finalDecision =
      creditDecision !== undefined
        ? mergeUnderwritingDecisions(creditDecision, result.decision)
        : result.decision;

    const aiEvaluation = await this.aiRiskScoring.evaluateForUnderwriting(
      application.userId,
      finalDecision,
    );
    finalDecision = aiEvaluation.decision;

    let decisionReason =
      creditScore !== undefined
        ? `${result.decisionReason}; credit band ${creditScore.band} (${creditScore.score}/1000) → ${creditDecision}, final ${finalDecision}`
        : result.decisionReason;

    if (aiEvaluation.aiRiskScore) {
      const ai = aiEvaluation.aiRiskScore;
      decisionReason += `; AI risk ${ai.riskBand} (score ${ai.score}, confidence ${ai.confidence})`
      if (aiEvaluation.overridden) {
        decisionReason += ' → escalated to manual review'
      }
    }

    await underwritingDecisionTraceStore.create({
      applicationId: application.applicationId,
      userId: application.userId,
      decision: finalDecision,
      totalScore: result.totalScore,
      maxScore: result.maxScore,
      triggeredRules: result.triggeredRules,
      decisionReason,
      ruleConfigVersion: this.ruleEngine.getConfig().version,
      aiRiskScore: aiEvaluation.aiRiskScore,
      evaluatedAt: result.evaluatedAt,
    });

    return {
      applicationId: application.applicationId,
      userId: application.userId,
      decision: finalDecision,
      result: { ...result, decision: finalDecision, decisionReason },
      creditScore,
      creditBandDecision: creditScore
        ? decisionFromCreditBand(creditScore.band)
        : undefined,
      aiRiskScore: aiEvaluation.aiRiskScore,
      evaluatedAt: result.evaluatedAt,
    };
  }

  /**
   * Update the rule engine configuration
   */
  updateRuleConfig(config: Partial<typeof DEFAULT_RULE_CONFIG>): void {
    this.ruleEngine.updateConfig(config);
  }

  /**
   * Get current rule engine configuration
   */
  getRuleConfig() {
    return this.ruleEngine.getConfig();
  }

  /**
   * Get rule engine instance (for testing)
   */
  getRuleEngine(): UnderwritingRuleEngine {
    return this.ruleEngine;
  }
}

// Singleton instance
export const underwritingService = new UnderwritingService();
