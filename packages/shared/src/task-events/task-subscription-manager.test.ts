/**
 * Tests for TaskSubscriptionManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskSubscriptionManager, matchesSubscription, type DeliverResult } from './task-subscription-manager.ts';
import type { TaskEvent, TaskSubscription } from './types.ts';

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 'evt_test1',
    type: 'completed',
    sessionId: 'task-a',
    sessionName: 'Task A',
    fromStatus: 'in-progress',
    toStatus: 'done',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('TaskSubscriptionManager', () => {
  let workspaceRoot: string;
  const deliveries: Array<{ sessionId: string; message: string }> = [];
  let deliverFailNext = false;
  let clock = 1_700_000_000_000;

  function makeManager(extra: Partial<Parameters<typeof TaskSubscriptionManager.prototype.subscribe>[0]> = {}) {
    return new TaskSubscriptionManager({
      workspaceRootPath: workspaceRoot,
      workspaceId: 'ws-test',
      deliver: async (sessionId, message): Promise<DeliverResult | void> => {
        if (deliverFailNext) {
          deliverFailNext = false;
          throw new Error('delivery transport down');
        }
        deliveries.push({ sessionId, message });
      },
      resolveStatus: (input) => ({ done: 'done', cancelled: 'cancelled' } as Record<string, string>)[input.toLowerCase()] ?? null,
      now: () => clock,
      ...extra,
    });
  }

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'polo-task-events-'));
    deliveries.length = 0;
    deliverFailNext = false;
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  describe('subscribe', () => {
    it('persists the subscription and reloads it in a new manager', () => {
      const manager = makeManager();
      const sub = manager.subscribe({ targetSessionId: 'task-a', subscriberSessionId: 'main' });
      expect(sub.id).toMatch(/^sub_/);
      expect(sub.events).toEqual(['completed', 'failed']);
      expect(sub.mode).toBe('once');

      const reloaded = makeManager();
      expect(reloaded.list('main').map((s) => s.id)).toEqual([sub.id]);
    });

    it('resolves status labels to ids at registration time', () => {
      const manager = makeManager();
      const sub = manager.subscribe({
        targetSessionId: 'task-a',
        subscriberSessionId: 'main',
        events: ['status_changed'],
        statuses: ['Done'],
      });
      expect(sub.statuses).toEqual(['done']);
    });

    it('keeps the raw value when the status cannot be resolved', () => {
      const manager = makeManager();
      const sub = manager.subscribe({
        targetSessionId: 'task-a',
        subscriberSessionId: 'main',
        events: ['status_changed'],
        statuses: ['custom-status'],
      });
      expect(sub.statuses).toEqual(['custom-status']);
    });

    it('rejects self-subscription', () => {
      const manager = makeManager();
      expect(() => manager.subscribe({ targetSessionId: 'main', subscriberSessionId: 'main' }))
        .toThrow(/SELF_SUBSCRIPTION_NOT_ALLOWED/);
    });

    it('rejects invalid specs', () => {
      const manager = makeManager();
      expect(() => manager.subscribe({ targetSessionId: '', subscriberSessionId: 'main' })).toThrow(/INVALID_SUBSCRIPTION_SPEC/);
      expect(() => manager.subscribe({ targetSessionId: 'a', subscriberSessionId: 'main', expiresAt: -1 })).toThrow(/INVALID_SUBSCRIPTION_SPEC/);
    });
  });

  describe('handleTaskEvent', () => {
    let manager: TaskSubscriptionManager;
    let sub: TaskSubscription;

    beforeEach(() => {
      manager = makeManager();
      sub = manager.subscribe({
        targetSessionId: 'task-a',
        subscriberSessionId: 'main',
        instruction: '继续下一步:合并分支',
      });
    });

    it('wakes the subscriber once and removes the once subscription', async () => {
      await manager.handleTaskEvent(makeEvent());

      expect(deliveries).toHaveLength(1);
      const { sessionId, message } = deliveries[0]!;
      expect(sessionId).toBe('main');
      expect(message).toContain('[Task event] completed');
      expect(message).toContain('Task A');
      expect(message).toContain('in-progress → done');
      expect(message).toContain('继续下一步:合并分支');

      expect(manager.list('main')).toHaveLength(0);
    });

    it('keeps a persistent subscription and bumps fireCount', async () => {
      manager.unsubscribe(sub.id);
      const persistent = manager.subscribe({
        targetSessionId: 'task-a',
        subscriberSessionId: 'main',
        mode: 'persistent',
      });

      await manager.handleTaskEvent(makeEvent());
      await manager.handleTaskEvent(makeEvent({ id: 'evt_test2' }));

      expect(deliveries).toHaveLength(2);
      const live = manager.list('main');
      expect(live).toHaveLength(1);
      expect(live[0]!.fireCount).toBe(2);
      expect(live[0]!.id).toBe(persistent.id);
    });

    it('ignores events that do not match target, type or statuses', async () => {
      manager.unsubscribe(sub.id);
      manager.subscribe({
        targetSessionId: 'task-a',
        subscriberSessionId: 'main',
        events: ['failed'],
      });
      await manager.handleTaskEvent(makeEvent()); // completed ≠ failed
      expect(deliveries).toHaveLength(0);

      manager.subscribe({
        targetSessionId: 'other-task',
        subscriberSessionId: 'main',
      });
      await manager.handleTaskEvent(makeEvent());
      expect(deliveries).toHaveLength(0);
    });

    it('narrows status-derived events by statuses but not custom events', async () => {
      manager.unsubscribe(sub.id);
      manager.subscribe({
        targetSessionId: 'task-a',
        subscriberSessionId: 'main',
        events: ['completed', 'custom'],
        statuses: ['done'],
      });

      await manager.handleTaskEvent(makeEvent({ toStatus: 'needs-review' }));
      expect(deliveries).toHaveLength(0);

      await manager.handleTaskEvent(makeEvent({ toStatus: 'done', type: 'custom', detail: '阶段完成' }));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.message).toContain('阶段完成');
    });

    it('merges multiple matching subscriptions into one wake-up', async () => {
      manager.subscribe({ targetSessionId: 'task-a', subscriberSessionId: 'main', instruction: '第二件事' });
      await manager.handleTaskEvent(makeEvent());

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.message).toContain('继续下一步:合并分支');
      expect(deliveries[0]!.message).toContain('第二件事');
    });

    it('keeps the subscription when delivery fails', async () => {
      deliverFailNext = true;
      await manager.handleTaskEvent(makeEvent());
      expect(deliveries).toHaveLength(0);
      expect(manager.list('main')).toHaveLength(1);
    });

    it('appends the event to the audit log', async () => {
      await manager.handleTaskEvent(makeEvent());
      const logPath = join(workspaceRoot, 'task-events', 'events.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const logged = JSON.parse(readFileSync(logPath, 'utf-8').trim().split('\n').at(-1)!);
      expect(logged.id).toBe('evt_test1');
    });
  });

  describe('unsubscribe', () => {
    it('only lets the owning subscriber remove its own subscription', () => {
      const manager = makeManager();
      const sub = manager.subscribe({ targetSessionId: 'task-a', subscriberSessionId: 'main' });

      expect(manager.unsubscribe(sub.id, 'someone-else')).toBe(false);
      expect(manager.list()).toHaveLength(1);
      expect(manager.unsubscribe(sub.id, 'main')).toBe(true);
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe('maintenance', () => {
    it('prunes expired subscriptions', () => {
      const manager = makeManager();
      manager.subscribe({ targetSessionId: 'task-a', subscriberSessionId: 'main' });
      manager.subscribe({ targetSessionId: 'task-a', subscriberSessionId: 'other', expiresAt: clock - 1 });

      expect(manager.pruneExpired()).toBe(1);
      expect(manager.list().map((s) => s.subscriberSessionId)).toEqual(['main']);
    });

    it('drops subscriptions pointing at removed sessions', () => {
      const manager = makeManager();
      manager.subscribe({ targetSessionId: 'task-a', subscriberSessionId: 'main' });
      manager.subscribe({ targetSessionId: 'task-b', subscriberSessionId: 'ghost' });

      manager.pruneForRemovedSessions(new Set(['main', 'task-a', 'task-b']));
      expect(manager.list().map((s) => s.subscriberSessionId)).toEqual(['main']);
    });
  });
});

describe('matchesSubscription', () => {
  const baseSub: TaskSubscription = {
    id: 'sub_x',
    targetSessionId: 'task-a',
    subscriberSessionId: 'main',
    events: ['completed'],
    mode: 'once',
    createdAt: 0,
    fireCount: 0,
  };

  it('matches on target and event type', () => {
    expect(matchesSubscription(baseSub, makeEvent())).toBe(true);
    expect(matchesSubscription(baseSub, makeEvent({ sessionId: 'task-b' }))).toBe(false);
    expect(matchesSubscription(baseSub, makeEvent({ type: 'failed' }))).toBe(false);
  });

  it('matches statuses case-insensitively', () => {
    const sub = { ...baseSub, events: ['status_changed' as const], statuses: ['DONE'] };
    expect(matchesSubscription(sub, makeEvent({ type: 'status_changed', toStatus: 'done' }))).toBe(true);
    expect(matchesSubscription(sub, makeEvent({ type: 'status_changed', toStatus: 'todo' }))).toBe(false);
  });
});
