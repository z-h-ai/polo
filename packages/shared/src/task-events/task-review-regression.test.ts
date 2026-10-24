import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskSubscriptionManager } from './task-subscription-manager.ts';
import { loadSubscriptions } from './task-subscription-store.ts';
import { loadTaskChains, translateTaskChainToSubscriptions } from './task-chain-loader.ts';
import type { TaskEvent } from './types.ts';

let root: string;
const managers: TaskSubscriptionManager[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'task-review-')); });
afterEach(() => { managers.forEach(m => m.dispose()); managers.length = 0; rmSync(root, { recursive: true, force: true }); });
function manager(deliver: ConstructorParameters<typeof TaskSubscriptionManager>[0]['deliver']) {
  const m = new TaskSubscriptionManager({ workspaceRootPath: root, deliver });
  managers.push(m);
  return m;
}
const event = (id = 'event-1'): TaskEvent => ({ id, type: 'completed', sessionId: 'worker', timestamp: Date.now() });
const spec = { targetSessionId: 'worker', subscriberSessionId: 'main' };

test('resolved delivery rejection retains once subscription and reports zero wakeups', async () => {
  const m = manager(async () => ({ ok: false, reason: 'offline' }));
  m.subscribe(spec);
  expect(await m.handleTaskEvent(event())).toBe(0);
  expect(m.list()).toHaveLength(1);
  expect(loadSubscriptions(root)).toHaveLength(1);
});

test('thrown delivery failure reports zero wakeups', async () => {
  const m = manager(async () => { throw new Error('offline'); });
  m.subscribe(spec);
  expect(await m.handleTaskEvent(event())).toBe(0);
});

test('concurrent events consume a once subscription once', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const m = manager(async () => { calls++; await barrier; });
  m.subscribe(spec);
  const first = m.handleTaskEvent(event());
  const second = m.handleTaskEvent(event('event-2'));
  release();
  expect(await Promise.all([first, second])).toEqual([1, 0]);
  expect(calls).toBe(1);
});

test('a failed completed event retries after restart without another upstream event', async () => {
  const first = manager(async () => ({ ok: false }));
  first.subscribe(spec);
  await first.handleTaskEvent(event());
  first.dispose();
  let calls = 0;
  const second = manager(async () => { calls++; });
  // Runtime timers, no LLM polling. Retry delay is bounded by the implementation.
  const deadline = Date.now() + 3500;
  while (!calls && Date.now() < deadline) await Bun.sleep(25);
  expect(calls).toBe(1);
  expect(second.list()).toHaveLength(0);
});

test('same event id does not refire a persistent subscription', async () => {
  let calls = 0;
  const m = manager(async () => { calls++; });
  m.subscribe({ ...spec, mode: 'persistent' });
  await m.handleTaskEvent(event());
  await m.handleTaskEvent(event());
  expect(calls).toBe(1);
});

test('all matching subscribers are durable before the first transport awaits', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const m = manager(async () => { started(); await barrier; });
  m.subscribe(spec);
  m.subscribe({ ...spec, subscriberSessionId: 'reviewer' });
  const delivery = m.handleTaskEvent(event());
  await ready;
  const state = JSON.parse(readFileSync(join(root, 'task-events/subscriptions.json'), 'utf8'));
  release();
  await delivery;
  expect(state.pendingDeliveries.flatMap((p: { subscriptionIds: string[] }) => p.subscriptionIds)).toHaveLength(2);
});

test('invalid stored subscriptions cannot break a valid listener', async () => {
  const first = manager(async () => {});
  first.subscribe(spec);
  const valid = loadSubscriptions(root)[0]!;
  writeFileSync(join(root, 'task-events/subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [{ ...valid, id: 'bad', events: null }, valid] }));
  const m = manager(async () => {});
  expect(await m.handleTaskEvent(event())).toBe(1);
  expect(m.list()).toHaveLength(0);
});

test('registration cannot acknowledge a subscription that failed to persist', () => {
  writeFileSync(join(root, 'task-events'), 'directory obstructed');
  const m = manager(async () => {});
  expect(() => m.subscribe(spec)).toThrow();
  expect(m.list()).toHaveLength(0);
});

for (const [name, steps] of [
  ['duplicate step ids', [{ id: 'a', session: 'one' }, { id: 'a', session: 'two' }]],
  ['session alias self edge', [{ id: 'a', session: 'one' }, { id: 'b', session: 'alias', after: 'a' }]],
] as const) {
  test(`rejects entire chain with ${name}`, () => {
    mkdirSync(join(root, 'task-events/chains'), { recursive: true });
    writeFileSync(join(root, 'task-events/chains/c.json'), JSON.stringify({ chain: 'test', steps }));
    const result = loadTaskChains(root, { resolveSession: name => ({ id: name === 'alias' ? 'one' : name }) });
    expect(result.chains).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
}


test('rejects a chain reusing a resolved session in non-adjacent steps', () => {
  mkdirSync(join(root, 'task-events/chains'), { recursive: true });
  writeFileSync(join(root, 'task-events/chains/reused.json'), JSON.stringify({
    chain: 'reused', steps: [
      { id: 'a', session: 'worker' },
      { id: 'b', session: 'reviewer', after: 'a' },
      { id: 'c', session: 'worker-alias', after: 'b' },
      { id: 'd', session: 'publisher', after: 'c' },
    ],
  }));
  const result = loadTaskChains(root, { resolveSession: name => ({ id: name === 'worker-alias' ? 'worker' : name }) });
  expect(result.chains).toHaveLength(0);
  expect(result.errors.join(' ')).toContain('session');
});


test('a YAML dependency wakes on explicit failure and guards its success instruction', async () => {
  const specs = translateTaskChainToSubscriptions({ chainName: 'failure', sourceFile: 'failure.yaml', steps: [
    { id: 'a', session: 'worker', sessionId: 'worker' },
    { id: 'b', session: 'main', sessionId: 'main', afterStepId: 'a', prompt: 'Publish the build.' },
  ] });
  const messages: string[] = [];
  const m = manager(async (_id, message) => { messages.push(message); });
  m.subscribe(specs[0]!);
  expect(await m.handleTaskEvent({ ...event(), type: 'failed', detail: 'build failed' })).toBe(1);
  expect(messages[0]).toContain('failure or cancellation');
  expect(messages[0]).toContain('Publish the build.');
});

test('reopening releases an undelivered old terminal so a once listener can receive the new result', async () => {
  let online = false;
  const messages: string[] = [];
  const m = manager(async (_id, message) => { if (!online) return { ok: false }; messages.push(message); });
  m.subscribe(spec);
  await m.handleTaskEvent({ ...event('old-result'), toStatus: 'done' });
  await m.handleTaskEvent({ ...event('reopen'), type: 'status_changed', fromStatus: 'done', toStatus: 'in-progress' });
  online = true;
  expect(await m.handleTaskEvent({ ...event('new-result'), toStatus: 'done' })).toBe(1);
  expect(messages[0]).toContain('new-result');
  expect(messages[0]).not.toContain('old-result');
});
