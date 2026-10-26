/**
 * Journey #5 — read-only projection of the independent verification receipt.
 *
 * Consumes ONLY the server-owned GoalVerificationReceipt + the candidate's
 * evidence list (protocol structs, read-only). Everything the receipt does
 * not report renders as 未知 — the panel never invents a model, an evidence
 * file, or a verification duration (only the receipt's own verifiedAt
 * timestamp and the goal's accumulated runtime exist as facts).
 */
import type { GoalRecord, GoalCriterionResult, GoalEvidence } from '@polo-ai/shared/protocol'

export type GoalEvidenceViewStatus = 'known-file' | 'known-message' | 'unknown'

export interface GoalEvidenceView {
  status: GoalEvidenceViewStatus
  /** Display text: file path, evidence note, or the unknown marker key. */
  label: string
  /** Workspace-resolvable path — present only for `known-file`. */
  path?: string
  /** Persisted message id — present only for `known-message`. */
  messageId?: string
}

export interface GoalCriterionView {
  criterion: string
  passed: boolean
  note?: string
  evidence: GoalEvidenceView[]
}

export interface GoalVerificationView {
  status: 'passed' | 'not_satisfied' | 'failed'
  verifiedAt: number
  /** Effective verifier model; null renders as 未知. */
  model: string | null
  warning?: string
  error?: string
  executionFactsNote?: string
  criteria: GoalCriterionView[]
}

const UNKNOWN_LABEL = 'goal.evidenceUnknown'

function evidenceView(evidence: GoalEvidence | undefined): GoalEvidenceView {
  if (!evidence) return { status: 'unknown', label: UNKNOWN_LABEL }
  if (evidence.kind === 'file') {
    if (evidence.path) return { status: 'known-file', label: evidence.path, path: evidence.path }
    return { status: 'unknown', label: UNKNOWN_LABEL }
  }
  if (evidence.kind === 'message') {
    if (evidence.messageId) {
      return { status: 'known-message', label: evidence.note || evidence.messageId, messageId: evidence.messageId }
    }
    return { status: 'unknown', label: UNKNOWN_LABEL }
  }
  return { status: 'unknown', label: UNKNOWN_LABEL }
}

function criterionView(
  criterion: GoalCriterionResult,
  pool: GoalEvidence[] | undefined,
): GoalCriterionView {
  const list = pool ?? []
  return {
    criterion: criterion.criterion,
    passed: criterion.passed === true,
    ...(criterion.note !== undefined && { note: criterion.note }),
    evidence: (criterion.evidenceIds ?? []).map(id => evidenceView(list[id])),
  }
}

/** Single read-only mapping from the record to the verification panel. */
export function describeGoalVerification(goal: GoalRecord): GoalVerificationView | null {
  const receipt = goal.verification
  if (!receipt) return null
  return {
    status: receipt.status,
    verifiedAt: receipt.verifiedAt,
    model: typeof receipt.model === 'string' && receipt.model.trim() ? receipt.model : null,
    ...(receipt.warning !== undefined && { warning: receipt.warning }),
    ...(receipt.error !== undefined && { error: receipt.error }),
    ...(receipt.executionFactsNote !== undefined && { executionFactsNote: receipt.executionFactsNote }),
    criteria: (receipt.criteria ?? []).map(c => criterionView(c, goal.candidate?.evidence)),
  }
}
