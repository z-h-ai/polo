/**
 * Integration tests: the full task pub/sub path
 *
 * Covers the two flows users actually exercise:
 * 1. subscribe → server restart → event → wake-up (persistence round-trip)
 * 2. chain file → loader → subscriptions → event → chain handoff
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskSubscriptionManager } from './task-subscription-manager.ts';
import { loadTaskChains, translateTaskChainToSubscriptions } from './task-chain-loader.ts';
import { loadSubscriptions } from './task-subscription-store.ts';

describe('task pub/sub integration', () => {
  let workspaceRoot: string;
  const deliveries: Array<{ sessionId: string; message: string }> = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'polo-task-events-it-'));
    deliveries.length = 0;
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeManager(): TaskSubscriptionManager {
    return new TaskSubscriptionManager({
      workspaceRootPath: workspaceRoot,
      workspaceId: 'ws-it',
      deliver: async (sessionId, message) => {
        deliveries.push({ sessionId, message });
      },
    });
  }

  it('wakes a subscriber that registered before a restart, exactly once', async () => {
    // Turn 1: the orchestrator session subscribes, then its turn ends.
    const first = makeManager();
    const sub = first.subscribe({
      targetSessionId: 'implement',
      subscriberSessionId: 'orchestrator',
      instruction: '实现完成,开始审查并合并分支。',
    });

    // "Restart": a fresh manager loads the persisted table.
    const second = makeManager();
    expect(second.list('orchestrator').map((s) => s.id)).toEqual([sub.id]);

    // The implement session finishes (status write → completed event).
    await second.handleTaskEvent({
      id: 'evt_1',
      type: 'completed',
      sessionId: 'implement',
      sessionName: 'Implement feature',
      fromStatus: 'in-progress',
      toStatus: 'done',
      timestamp: 1,
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.sessionId).toBe('orchestrator');
    expect(deliveries[0]!.message).toContain('[Task event] completed');
    expect(deliveries[0]!.message).toContain('实现完成,开始审查并合并分支。');

    // once-fired: gone from memory AND from disk.
    expect(second.list()).toHaveLength(0);
    expect(loadSubscriptions(workspaceRoot)).toHaveLength(0);
  });

  it('applies a declarative chain file and hands off across sessions', async () => {
    const chainsDir = join(workspaceRoot, 'task-events', 'chains');
    mkdirSync(chainsDir, { recursive: true });
    writeFileSync(
      join(chainsDir, 'review.yaml'),
      [
        'chain: review-after-implement',
        'steps:',
        '  - id: implement',
        '    session: Implement feature',
        '  - id: review',
        '    after: implement',
        '    session: Reviewer',
        '    prompt: 审查实现的产出,先跑测试。',
      ].join('\n'),
    );

    const resolveSession = (nameOrId: string) =>
      nameOrId === 'Implement feature' ? { id: 'sess-impl', name: 'Implement feature' }
        : nameOrId === 'Reviewer' ? { id: 'sess-review', name: 'Reviewer' }
        : null;

    const manager = makeManager();
    const { chains, errors } = loadTaskChains(workspaceRoot, { resolveSession });
    expect(errors).toEqual([]);
    for (const chain of chains) {
      for (const spec of translateTaskChainToSubscriptions(chain)) {
        manager.subscribe(spec);
      }
    }
    // The entry step never produces a subscription.
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]!.source).toBe('chain:review.yaml#review');

    await manager.handleTaskEvent({
      id: 'evt_chain_1',
      type: 'completed',
      sessionId: 'sess-impl',
      sessionName: 'Implement feature',
      fromStatus: 'in-progress',
      toStatus: 'done',
      timestamp: 1,
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.sessionId).toBe('sess-review');
    expect(deliveries[0]!.message).toContain('审查实现的产出,先跑测试。');
  });
});
