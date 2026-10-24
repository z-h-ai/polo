/**
 * Task Events — Pub/Sub contract for chained task orchestration (POO-126)
 *
 * The contract behind task-chain orchestration: instead of an agent loop
 * polling `get_session_info` / `list_sessions` for a downstream task's
 * outcome (one LLM round-trip per check), a subscriber session registers a
 * TaskSubscription once and is woken up by an injected message when the
 * observed task emits a matching event.
 *
 * Layering:
 * - Layer 0 (this file): the agreed event + subscription schema
 * - Layer 1: TaskSubscriptionManager — matching, persistence, wake-up delivery
 * - Layer 2: session tools (subscribe_task / emit_task_event / ...) wired
 *   through the session-scoped callback registry
 * - Layer 3: declarative chains ({workspace}/task-events/chains/*.yaml)
 * - Layer 4: natural language ("when POO-127 finishes, continue with X")
 *
 * Event sources:
 * - `status_changed` / `completed` — derived from session status
 *   transitions (SessionManager.setSessionStatus). Terminal semantics follow
 *   the workspace status config: a status whose `category` is 'closed'
 *   completes a subscription; statuses may also be matched explicitly.
 * - `failed` / `custom` (or explicit `completed`) — emitted by an agent through emit_task_event with a detail
 *   message, so chains are not restricted to status endpoints.
 */

import { z } from 'zod';

// ============================================================
// Event types
// ============================================================

/** The event types a subscription can observe. */
export const TASK_EVENT_TYPES = ['status_changed', 'completed', 'failed', 'custom'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/**
 * A task event: something observable that happened to a session.
 */
export interface TaskEvent {
  /** Unique event id (dedupe key for subscribers). */
  id: string;
  type: TaskEventType;
  /** Session the event happened in. */
  sessionId: string;
  sessionName?: string;
  workspaceId?: string;
  /** Previous status (status_changed / completed / failed events). */
  fromStatus?: string;
  /** New status (status_changed / completed / failed events). */
  toStatus?: string;
  /** Free-text detail — emit_task_event's message or a status-change note. */
  detail?: string;
  /** Who produced the event: 'system' for derived events, else a session id. */
  emittedBy?: string;
  timestamp: number;
}

// ============================================================
// Subscriptions
// ============================================================

/** Delivery mode: `once` removes the subscription after the first wake-up. */
export type TaskSubscriptionMode = 'once' | 'persistent';

/**
 * What a subscriber registers. Created via subscribe_task (agent tool) or
 * translated from a declarative chain file.
 */
export interface TaskSubscriptionSpec {
  /** Session to observe. */
  targetSessionId: string;
  /** Session to wake up when a matching event arrives. */
  subscriberSessionId: string;
  /** Event types to observe. Defaults to ['completed', 'failed']. */
  events?: TaskEventType[];
  /** Optional narrow: for status events, only these status ids/labels match. */
  statuses?: string[];
  /** Appended to the wake-up message so the subscriber knows what to do next. */
  instruction?: string;
  /** Defaults to 'once' — chain handoffs are single-shot. */
  mode?: TaskSubscriptionMode;
  /** Optional absolute epoch ms after which the subscription is pruned. */
  expiresAt?: number;
  /** Free-form provenance (e.g. the chain file + step that created it). */
  source?: string;
}

/** A stored subscription (spec + bookkeeping). */
export interface TaskSubscription extends TaskSubscriptionSpec {
  id: string;
  events: TaskEventType[];
  mode: TaskSubscriptionMode;
  createdAt: number;
  fireCount: number;
  lastFiredAt?: number;
  lastEventId?: string;
}

// ============================================================
// Zod schemas (validation at the boundaries)
// ============================================================

export const taskEventTypeSchema = z.enum(TASK_EVENT_TYPES);

export const taskSubscriptionSpecSchema = z.object({
  targetSessionId: z.string().min(1),
  subscriberSessionId: z.string().min(1),
  events: z.array(taskEventTypeSchema).nonempty().optional(),
  statuses: z.array(z.string().min(1)).nonempty().optional(),
  instruction: z.string().optional(),
  mode: z.enum(['once', 'persistent']).optional(),
  expiresAt: z.number().int().positive().optional(),
  source: z.string().optional(),
});

export const taskEventSchema = z.object({
  id: z.string().min(1),
  type: taskEventTypeSchema,
  sessionId: z.string().min(1),
  sessionName: z.string().optional(),
  workspaceId: z.string().optional(),
  fromStatus: z.string().optional(),
  toStatus: z.string().optional(),
  detail: z.string().optional(),
  emittedBy: z.string().optional(),
  timestamp: z.number(),
});

export const taskSubscriptionSchema = taskSubscriptionSpecSchema.extend({
  id: z.string().min(1),
  events: z.array(taskEventTypeSchema).nonempty(),
  mode: z.enum(['once', 'persistent']),
  createdAt: z.number(),
  fireCount: z.number().int().nonnegative(),
  lastFiredAt: z.number().optional(),
  lastEventId: z.string().optional(),
}).refine(s => s.targetSessionId !== s.subscriberSessionId);

export interface PendingTaskDelivery {
  event: TaskEvent;
  subscriptionIds: string[];
}

// ============================================================
// Delivery envelope
// ============================================================

/**
 * The wake-up message injected into the subscriber session. Rendered by
 * TaskSubscriptionManager; keep the shape stable — agents' instructions in
 * prompts reference the bracketed header.
 */
export function renderTaskEventMessage(event: TaskEvent, subscription: TaskSubscription): string {
  const lines: string[] = [];
  lines.push(`[Task event] ${event.type} — session "${event.sessionName ?? event.sessionId}" (${event.sessionId})`);
  if (event.fromStatus || event.toStatus) {
    lines.push(`Status: ${event.fromStatus ?? '?'} → ${event.toStatus ?? '?'}`);
  }
  if (event.detail) {
    lines.push(`Detail: ${event.detail}`);
  }
  if (subscription.instruction) {
    const guidance = event.type === 'completed' || event.type === 'failed'
      ? 'First verify the upstream outcome. On failure or cancellation, report the reason and stop; execute the subscription instruction only on success:'
      : 'Subscription instruction — act on it now:';
    lines.push('', guidance, subscription.instruction);
  }
  lines.push('', `(subscription ${subscription.id}, event ${event.id})`);
  return lines.join('\n');
}
