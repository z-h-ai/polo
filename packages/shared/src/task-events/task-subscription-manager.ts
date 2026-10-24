/**
 * TaskSubscriptionManager — Layer 1 of the task pub/sub contract
 *
 * Owns the per-workspace subscription table: registration, persistence,
 * event matching and wake-up delivery. Pure orchestration logic — the
 * workspace wiring (deliver = SessionManager.sendMessage, status vocabulary)
 * is injected, so the manager is unit-testable without a server.
 *
 * Wake-up semantics: when an event matches, ONE message is injected per
 * subscriber session (multiple matching subscriptions are merged into a
 * single wake-up so one event never starts two turns in the same session).
 * Delivery goes through the injected `deliver` callback, which the
 * SessionManager binds to sendMessage — the same channel send_agent_message
 * uses, so the subscriber starts a fresh turn with the event in context.
 */

import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/debug.ts';
import {
  loadTaskSubscriptionState,
  saveSubscriptions,
  subscriptionsFilePath,
} from './task-subscription-store.ts';
import {
  renderTaskEventMessage,
  taskSubscriptionSpecSchema,
  taskEventSchema,
  type PendingTaskDelivery,
  type TaskEvent,
  type TaskEventType,
  type TaskSubscription,
  type TaskSubscriptionSpec,
} from './types.ts';

const log = createLogger('task-subscriptions');

export interface DeliverResult {
  ok: boolean;
  reason?: string;
}

export interface TaskSubscriptionManagerOptions {
  workspaceRootPath: string;
  workspaceId?: string;
  /**
   * Wake-up channel. Bound to SessionManager.sendMessage so a wake-up starts
   * a fresh turn in the subscriber session. Failures keep the subscription —
   * a persisted runtime retry delivers the original event (a chain handoff must not
   * be silently dropped).
   */
  deliver: (subscriberSessionId: string, message: string) => Promise<DeliverResult | void>;
  /** Resolves a status id or display label to its canonical id. */
  resolveStatus?: (input: string) => string | null;
  /** Resolves a session's display name for wake-up envelopes (best effort). */
  resolveSessionName?: (sessionId: string) => string | undefined;
  /** Revalidate current permission scope immediately before delivery. */
  canDeliver?: (subscription: TaskSubscription, event: TaskEvent) => boolean;
  /** Recover durably accepted queued wakeups after a restart; false defers. */
  recoverQueued?: (subscriberSessionId: string) => Promise<boolean>;
  /** Clock override for tests. */
  now?: () => number;
}

function newSubscriptionId(): string {
  return `sub_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Does `event` satisfy `subscription`? Exported for tests. `statuses`
 * narrows status-derived events (matched against the canonical id OR the
 * display label, case-insensitive); custom events ignore it.
 */
export function matchesSubscription(subscription: TaskSubscription, event: TaskEvent): boolean {
  if (subscription.targetSessionId !== event.sessionId) return false;
  if (!subscription.events.includes(event.type)) return false;
  if (subscription.statuses?.length && event.type !== 'custom') {
    const status = (event.toStatus ?? '').toLowerCase();
    const hit = subscription.statuses.some((s) => s.toLowerCase() === status);
    if (!hit) return false;
  }
  return true;
}

export class TaskSubscriptionManager {
  private subscriptions: TaskSubscription[];
  private readonly opts: TaskSubscriptionManagerOptions;
  private disposed = false;
  private intake: Promise<unknown> = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pendingDeliveries: PendingTaskDelivery[];
  private terminalEvents: Map<string, TaskEvent>;
  private completedChainEdges: Set<string>;
  private acceptedSubscribers: Set<string>;


  constructor(opts: TaskSubscriptionManagerOptions) {
    this.opts = opts;
    const state = loadTaskSubscriptionState(opts.workspaceRootPath);
    this.subscriptions = state.subscriptions;
    this.pendingDeliveries = state.pendingDeliveries ?? [];
    this.terminalEvents = new Map((state.terminalEvents ?? []).map(e => [e.sessionId, e]));
    this.completedChainEdges = new Set(state.completedChainEdges ?? []);
    this.acceptedSubscribers = new Set(state.acceptedSubscribers ?? []);
    this.scheduleRetry();
  }

  // ============================================================
  // Registration
  // ============================================================

  /**
   * Register a subscription. Rejects self-subscription outright — a session
   * observing itself wakes itself forever (same guard as send_agent_message's
   * self-send block).
   */
  subscribe(spec: TaskSubscriptionSpec): TaskSubscription {
    this.assertNotDisposed();
    const parsed = taskSubscriptionSpecSchema.safeParse(spec);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`INVALID_SUBSCRIPTION_SPEC: ${issue?.path.join('.')} ${issue?.message}`);
    }
    const s = parsed.data;
    if (s.targetSessionId === s.subscriberSessionId) {
      throw new Error('SELF_SUBSCRIPTION_NOT_ALLOWED: subscribe to a different session than the subscriber.');
    }

    const statuses = s.statuses
      ?.map((raw) => this.opts.resolveStatus?.(raw) ?? raw);

    const subscription: TaskSubscription = {
      ...s,
      statuses: statuses?.length ? statuses : undefined,
      events: s.events ?? ['completed', 'failed'],
      mode: s.mode ?? 'once',
      id: newSubscriptionId(),
      createdAt: this.opts.now?.() ?? Date.now(),
      fireCount: 0,
    };
    this.subscriptions.push(subscription);
    try { this.persist(); }
    catch (error) { this.subscriptions.pop(); throw error; }
    log.debug(`[${subscription.id}] ${subscription.subscriberSessionId} -> ${subscription.targetSessionId} (${subscription.events.join(',')})`);
    return subscription;
  }

  /**
   * Remove a subscription. When `subscriberSessionId` is given, only that
   * session's own subscriptions can be removed — a session cannot cancel
   * another session's listener.
   */
  unsubscribe(subscriptionId: string, subscriberSessionId?: string): boolean {
    this.assertNotDisposed();
    const idx = this.subscriptions.findIndex((sub) => {
      if (sub.id !== subscriptionId) return false;
      if (subscriberSessionId !== undefined && sub.subscriberSessionId !== subscriberSessionId) return false;
      return true;
    });
    if (idx === -1) return false;
    this.subscriptions.splice(idx, 1);
    this.persist();
    return true;
  }

  /** List subscriptions, optionally narrowed to one subscriber session. */
  list(subscriberSessionId?: string): TaskSubscription[] {
    const subs = subscriberSessionId === undefined
      ? this.subscriptions
      : this.subscriptions.filter((sub) => sub.subscriberSessionId === subscriberSessionId);
    return [...subs];
  }

  // ============================================================
  // Event intake
  // ============================================================

  /**
   * Intake one task event: prune expired subscriptions, match, merge
   * per-subscriber, deliver, then apply fire bookkeeping (once/persistent).
   * Returns the number of subscriber sessions woken up.
   */
  handleTaskEvent(event: TaskEvent): Promise<number> {
    this.assertNotDisposed();
    const parsed = taskEventSchema.parse(event);
    return this.enqueue(async () => {
      this.pruneExpired();
      const name = parsed.sessionName ?? this.opts.resolveSessionName?.(parsed.sessionId);
      const enriched = name ? { ...parsed, sessionName: name } : parsed;
      this.logEvent(enriched);
      if (enriched.type === 'status_changed') this.invalidateTerminalState(enriched.sessionId);
      if (enriched.type === 'completed' || enriched.type === 'failed') this.terminalEvents.set(enriched.sessionId, enriched);
      return this.dispatch(enriched);
    });
  }

  /** Replay only to the newly armed listener, never to existing listeners. */
  replay(subscriptionId: string, resolveEvent: () => TaskEvent | undefined): Promise<number> {
    return this.enqueue(async () => {
      const event = resolveEvent();
      if (!event) return 0;
      // Reuse a synthesized closed-state event after restart as well. A
      // persistent listener must not see a new ID for the same terminal state.
      if (event.type === 'completed' || event.type === 'failed') this.terminalEvents.set(event.sessionId, event);
      return this.dispatch(event, subscriptionId);
    });
  }

  hasCompletedChainEdge(spec: TaskSubscriptionSpec): boolean {
    return this.completedChainEdges.has(this.chainEdgeKey(spec));
  }

  hasSameChainDefinition(a: TaskSubscriptionSpec, b: TaskSubscriptionSpec): boolean {
    return this.chainEdgeKey(a) === this.chainEdgeKey(b);
  }

  private chainEdgeKey(spec: TaskSubscriptionSpec): string {
    return JSON.stringify([spec.source, spec.targetSessionId, spec.subscriberSessionId,
      spec.events ?? ['completed', 'failed'], spec.statuses ?? [], spec.instruction ?? '']);
  }

  getLatestTerminalEvent(sessionId: string): TaskEvent | undefined {
    return this.terminalEvents.get(sessionId);
  }

  /** Reopening invalidates outcomes not yet accepted by any subscriber. */
  invalidateTerminalState(sessionId: string): void {
    this.terminalEvents.delete(sessionId);
    this.pendingDeliveries = this.pendingDeliveries.filter(p => p.event.sessionId !== sessionId
      || (p.event.type !== 'completed' && p.event.type !== 'failed'));
    this.persist();
  }

  private enqueue(operation: () => Promise<number>): Promise<number> {
    const result = this.intake.then(() => this.disposed ? 0 : operation());
    this.intake = result.catch(() => {});
    return result;
  }

  private async dispatch(event: TaskEvent, onlySubscriptionId?: string): Promise<number> {
    const reserved = new Set(this.pendingDeliveries.flatMap(p => p.subscriptionIds));
    const bySubscriber = new Map<string, TaskSubscription[]>();
    for (const sub of this.subscriptions) {
      if (onlySubscriptionId && sub.id !== onlySubscriptionId) continue;
      if (sub.expiresAt !== undefined && sub.expiresAt <= (this.opts.now?.() ?? Date.now())) continue;
      if (sub.lastEventId === event.id || !matchesSubscription(sub, event)) continue;
      if (sub.mode === 'once' && reserved.has(sub.id)) continue;
      if (this.pendingDeliveries.some(p => p.event.id === event.id && p.subscriptionIds.includes(sub.id))) continue;
      const bucket = bySubscriber.get(sub.subscriberSessionId) ?? [];
      bucket.push(sub);
      bySubscriber.set(sub.subscriberSessionId, bucket);
    }
    let delivered = 0;
    const pendingForEvent = [...bySubscriber.values()].map(subs => ({ event, subscriptionIds: subs.map(s => s.id) }));
    this.pendingDeliveries.push(...pendingForEvent);
    // Stage ALL recipients and terminal history in one atomic snapshot.
    this.persist();
    for (const pending of pendingForEvent) {
      if (await this.deliverPending(pending)) delivered++;
    }
    this.scheduleRetry();
    return delivered;
  }

  private async deliverPending(pending: PendingTaskDelivery): Promise<boolean> {
    const now = this.opts.now?.() ?? Date.now();
    const subs = this.subscriptions.filter(s => pending.subscriptionIds.includes(s.id)
      && (s.expiresAt === undefined || s.expiresAt > now));
    const primary = subs[0];
    if (!primary) {
      this.pendingDeliveries = this.pendingDeliveries.filter(p => p !== pending);
      this.persist();
      return false;
    }
    if (subs.some(s => this.opts.canDeliver && !this.opts.canDeliver(s, pending.event))) return false;
    const instruction = subs.map(s => s.instruction).filter(Boolean).join('\n') || undefined;
    let message = renderTaskEventMessage(pending.event, { ...primary, instruction });
    if (subs.length > 1) message += `\n(matching subscriptions: ${subs.map(s => s.id).join(', ')})`;
    try {
      const result = await this.opts.deliver(primary.subscriberSessionId, message);
      if (result && !result.ok) return false;
    } catch (error) {
      log.warn(`[${primary.id}] delivery failed, retaining handoff: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    // Disposal must not overwrite the persisted state of a successor manager.
    if (this.disposed) return false;
    if (this.opts.recoverQueued) this.acceptedSubscribers.add(primary.subscriberSessionId);
    for (const sub of subs) {
      sub.fireCount++;
      sub.lastFiredAt = pending.event.timestamp;
      sub.lastEventId = pending.event.id;
      if (sub.mode === 'once' && sub.source?.startsWith('chain:')) {
        this.completedChainEdges.add(this.chainEdgeKey(sub));
      }
    }
    const firedOnce = new Set(subs.filter(s => s.mode === 'once').map(s => s.id));
    this.subscriptions = this.subscriptions.filter(s => !firedOnce.has(s.id));
    this.pendingDeliveries = this.pendingDeliveries.filter(p => p !== pending);
    this.persist();
    return true;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer || (!this.pendingDeliveries.length && !this.acceptedSubscribers.size)) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.enqueue(async () => {
        this.pruneExpired();
        let delivered = 0;
        for (const pending of [...this.pendingDeliveries]) {
          if (this.disposed) break;
          if (await this.deliverPending(pending)) delivered++;
        }
        for (const id of [...this.acceptedSubscribers]) {
          if (this.disposed) break;
          if (await this.opts.recoverQueued?.(id)) {
            this.acceptedSubscribers.delete(id);
            this.persist();
          }
        }
        return delivered;
      }).catch(error => log.error(`handoff retry failed: ${String(error)}`))
        .finally(() => this.scheduleRetry());
    }, 1000);
    this.retryTimer.unref?.();
  }

  /** Append a delivery-safe event record for audit/debug (best effort). */
  logEvent(event: TaskEvent): void {
    try {
      const dir = join(this.opts.workspaceRootPath, 'task-events');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`event log append failed: ${msg}`);
    }
  }

  /** Build a well-formed TaskEvent (ids, timestamps). */
  buildEvent(input: Omit<TaskEvent, 'id' | 'timestamp'> & { timestamp?: number }): TaskEvent {
    return {
      ...input,
      id: newEventId(),
      timestamp: input.timestamp ?? this.opts.now?.() ?? Date.now(),
    };
  }

  // ============================================================
  // Maintenance
  // ============================================================

  /** Drop expired subscriptions; returns how many were removed. */
  pruneExpired(): number {
    const now = this.opts.now?.() ?? Date.now();
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.expiresAt === undefined || sub.expiresAt > now,
    );
    const removed = before - this.subscriptions.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Drop every subscription pointing at sessions that no longer exist. */
  pruneForRemovedSessions(liveSessionIds: Set<string>): number {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(
      (sub) => liveSessionIds.has(sub.subscriberSessionId) && liveSessionIds.has(sub.targetSessionId),
    );
    const removed = before - this.subscriptions.length;
    let removedEvents = false;
    for (const id of this.terminalEvents.keys()) {
      if (!liveSessionIds.has(id)) { this.terminalEvents.delete(id); removedEvents = true; }
    }
    for (const id of this.acceptedSubscribers) {
      if (!liveSessionIds.has(id)) { this.acceptedSubscribers.delete(id); removedEvents = true; }
    }
    if (removed > 0 || removedEvents) this.persist();
    return removed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.subscriptions = [];
  }

  getFilePath(): string {
    return subscriptionsFilePath(this.opts.workspaceRootPath);
  }

  // ============================================================
  // Internals
  // ============================================================

  private persist(): void {
    const ids = new Set(this.subscriptions.map(s => s.id));
    this.pendingDeliveries = this.pendingDeliveries.filter(p => p.subscriptionIds.some(id => ids.has(id)));
    saveSubscriptions(this.opts.workspaceRootPath, this.subscriptions, {
      pendingDeliveries: this.pendingDeliveries,
      terminalEvents: [...this.terminalEvents.values()],
      completedChainEdges: [...this.completedChainEdges],
      acceptedSubscribers: [...this.acceptedSubscribers],
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('TASK_SUBSCRIPTION_MANAGER_DISPOSED');
  }
}

// ============================================================
// Event derivation helpers (used by the event source)
// ============================================================

/** Default closed/completed vocabulary when a workspace has no status config. */
export const DEFAULT_CLOSED_STATUS_IDS = ['done', 'cancelled', 'complete', 'completed'];
