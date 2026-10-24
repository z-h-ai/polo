/**
 * Task subscription persistence
 *
 * Subscriptions live at {workspaceRootPath}/task-events/subscriptions.json so
 * they survive a server restart: a subscriber that registered before the
 * restart still gets woken up when the observed task completes. Writes are
 * atomic (tmp + rename) — the same discipline as statuses/config.json.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { taskSubscriptionSchema, taskEventSchema, type TaskSubscription, type PendingTaskDelivery, type TaskEvent } from './types.ts';

const TASK_EVENTS_DIR = 'task-events';
const SUBSCRIPTIONS_FILE = 'task-events/subscriptions.json';

export function taskEventsDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, TASK_EVENTS_DIR);
}

export function subscriptionsFilePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, SUBSCRIPTIONS_FILE);
}

interface SubscriptionsFile {
  version: 1;
  subscriptions: TaskSubscription[];
  pendingDeliveries?: PendingTaskDelivery[];
  terminalEvents?: TaskEvent[];
  completedChainEdges?: string[];
  acceptedSubscribers?: string[];
}

export function loadSubscriptions(workspaceRootPath: string): TaskSubscription[] {
  return loadTaskSubscriptionState(workspaceRootPath).subscriptions;
}

export function loadTaskSubscriptionState(workspaceRootPath: string): SubscriptionsFile {
  const path = subscriptionsFilePath(workspaceRootPath);
  const empty: SubscriptionsFile = { version: 1, subscriptions: [], pendingDeliveries: [], terminalEvents: [] };
  if (!existsSync(path)) return empty;
  try {
    const parsed = readJsonFileSync<SubscriptionsFile>(path);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.subscriptions)) return empty;
    const subscriptions = parsed.subscriptions.flatMap(s => {
      const result = taskSubscriptionSchema.safeParse(s);
      return result.success ? [result.data] : [];
    });
    const ids = new Set(subscriptions.map(s => s.id));
    const pendingDeliveries = (Array.isArray(parsed.pendingDeliveries) ? parsed.pendingDeliveries : []).flatMap(p => {
      if (!p || !Array.isArray(p.subscriptionIds)) return [];
      const event = taskEventSchema.safeParse(p.event);
      const subscriptionIds = p.subscriptionIds.filter(id => typeof id === 'string' && ids.has(id));
      return event.success && subscriptionIds.length ? [{ event: event.data, subscriptionIds }] : [];
    });
    const terminalEvents = (Array.isArray(parsed.terminalEvents) ? parsed.terminalEvents : []).flatMap(e => {
      const result = taskEventSchema.safeParse(e);
      return result.success && ['completed', 'failed'].includes(result.data.type) ? [result.data] : [];
    });
    const completedChainEdges = Array.isArray(parsed.completedChainEdges)
      ? parsed.completedChainEdges.filter(key => typeof key === 'string') : [];
    const acceptedSubscribers = Array.isArray(parsed.acceptedSubscribers)
      ? parsed.acceptedSubscribers.filter(id => typeof id === 'string') : [];
    return { version: 1, subscriptions, pendingDeliveries, terminalEvents, completedChainEdges, acceptedSubscribers };
  } catch {
    // A corrupt file must not take the workspace down — start empty, the
    // next save rewrites a valid snapshot.
    return empty;
  }
}

export function saveSubscriptions(workspaceRootPath: string, subscriptions: TaskSubscription[], state?: Pick<SubscriptionsFile, 'pendingDeliveries' | 'terminalEvents' | 'completedChainEdges' | 'acceptedSubscribers'>): void {
  const file: SubscriptionsFile = { version: 1, subscriptions, ...state };
  atomicWriteFileSync(subscriptionsFilePath(workspaceRootPath), JSON.stringify(file, null, 2));
}
