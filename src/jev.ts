import { TypeSafeClient, type SystemOneResult } from "@typesafe-ai/sdk";
import type { ReviewState } from "./git";
import { reviewInstructions, reviewQuestions } from "./questions";

type Result = SystemOneResult<typeof reviewQuestions>;
export type Thresholds = Partial<Record<keyof typeof reviewQuestions, number>>;

export const isRisk = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function validateThresholds(thresholds: unknown, requireAll = false): Thresholds {
  const ids = Object.keys(reviewQuestions);
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
    throw new Error("thresholds must be an object");
  }
  for (const [id, value] of Object.entries(thresholds)) {
    if (!ids.includes(id) || !isRisk(value)) {
      throw new Error(`Invalid threshold: ${id}`);
    }
  }
  if (requireAll && Object.keys(thresholds).length !== ids.length) {
    throw new Error("Policy must set a threshold for every built-in question");
  }
  return thresholds as Thresholds;
}

export function assessReview(state: ReviewState, result?: Result, maxRisk = 20, thresholds: Thresholds = {}) {
  if (!isRisk(maxRisk)) {
    throw new Error("max-risk must be a number from 0 to 100");
  }
  validateThresholds(thresholds);
  if (state.truncated || state.opaqueChanges) {
    return {
      decision: "human_review" as const, riskScore: null, maxRisk, thresholds,
      reasons: [
        ...(state.truncated ? ["truncated_diff"] : []),
        ...(state.opaqueChanges ? ["binary_or_submodule_changes"] : []),
      ],
      signals: [],
    };
  }
  const ids = Object.keys(reviewQuestions);
  const signals = ids.map(id => {
    const answer = result?.answers?.[id as keyof typeof reviewQuestions];
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error(`Missing or invalid Jev answer: ${id}`);
    }
    return { id, risk: answer.noul * 100, threshold: thresholds[id as keyof Thresholds] ?? maxRisk };
  });
  // ponytail: worst individual signal, not a calibrated overall failure probability; calibrate on labelled PRs before waiving reviews.
  const riskScore = Math.max(...signals.map(signal => signal.risk));
  const reasons = signals.filter(signal => signal.risk > signal.threshold).map(signal => signal.id);
  return {
    decision: reasons.length ? "human_review" as const : "merge_candidate" as const,
    riskScore, maxRisk, thresholds, reasons, signals,
  };
}

export function reviewRequest(state: ReviewState) {
  return { state: { instructions: reviewInstructions, ...state }, questions: reviewQuestions };
}

export async function evaluateReview(state: ReviewState, client = new TypeSafeClient()) {
  return client.systemOne(reviewRequest(state));
}
