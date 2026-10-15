import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, AuthStorage, SessionManager, SettingsManager, type AgentSession } from '@mariozechner/pi-coding-agent';
import { createAssistantMessageEventStream, getModel } from '@mariozechner/pi-ai';
import * as lifecycle from './prompt-turn-context.ts';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
// The optional settlement callback is the production FIFO/lifetime contract.
// Before the fix, JS accepts but ignores it: the real SDK tails are dropped.
type SettlingTurns = lifecycle.PromptTurnContexts & { run<T>(turnId: string, operation: () => Promise<T>, settle: () => Promise<void>): Promise<T> };
const drain = lifecycle as typeof lifecycle & { createPiPromptEventDrain(session: AgentSession): () => Promise<void> };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'polo-pi-event-drain-')), blocked = deferred(), reached = deferred();
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey('openai', 'owned-stream-only-no-network');
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
    extensionFactories: [pi => { pi.on('message_end', async event => { if (event.message.role === 'assistant') { reached.resolve(); await blocked.promise; } }); }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager: settings, authStorage: auth, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), model: getModel('openai', 'gpt-4o'), tools: [] });
  session.agent.streamFn = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = { role: 'assistant' as const, api: 'openai-completions' as const, provider: 'openai', model: 'gpt-4o', content: [{ type: 'text' as const, text: 'owned SDK output' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() };
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(message);
    });
    return stream;
  };
  return { session, reached, release: blocked.resolve, async cleanup() { blocked.resolve(); await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue; session.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}

it('forwards original A terminal events queued by the real SDK after prompt() resolves', async () => {
  const f = await fixture(), turns = new lifecycle.PromptTurnContexts() as SettlingTurns, returned = deferred(), forwarded: string[] = [];
  const a = turns.run(A, async () => {
    const original = turns.capture();
    f.session.subscribe(event => { try { turns.assert(original); } catch { return; } if (event.type === 'agent_end' || event.type === 'message_end' && event.message.role === 'assistant') forwarded.push(`${original.turnId}:${event.type}`); });
    await f.session.prompt('owned A'); returned.resolve();
  }, () => drain.createPiPromptEventDrain(f.session)());
  try {
    await returned.promise; await f.reached.promise;
    expect(forwarded).toEqual([]); // SDK operation returned while extension still owns the tail.
    f.release(); await a;
    expect(forwarded).toEqual([`${A}:message_end`, `${A}:agent_end`]);
  } finally { f.release(); await a.catch(() => {}); await f.cleanup(); }
});

it('B cannot replace the real session subscription before A message_end/agent_end drain', async () => {
  const f = await fixture(), turns = new lifecycle.PromptTurnContexts() as SettlingTurns, returned = deferred(), order: string[] = [];
  let unsubscribe: (() => void) | undefined;
  const a = turns.run(A, async () => {
    const original = turns.capture();
    unsubscribe = f.session.subscribe(event => { try { turns.assert(original); } catch { return; } if (event.type === 'agent_end' || event.type === 'message_end' && event.message.role === 'assistant') order.push(`A:${event.type}`); });
    await f.session.prompt('owned A'); returned.resolve();
  }, () => drain.createPiPromptEventDrain(f.session)());
  let b: Promise<void> | undefined;
  try {
    await returned.promise; await f.reached.promise;
    b = turns.run(B, async () => { unsubscribe?.(); order.push('B:subscribed'); });
    await Promise.resolve(); await Promise.resolve(); f.release(); await Promise.all([a, b]);
    expect(order).toEqual(['A:message_end', 'A:agent_end', 'B:subscribed']);
  } finally { f.release(); await Promise.allSettled([a, b]); await f.cleanup(); }
});

it('abort keeps a late A tool approval forbidden while its real SDK event queue drains', async () => {
  const f = await fixture(), turns = new lifecycle.PromptTurnContexts() as SettlingTurns, returned = deferred(), approval = deferred(); let executed = 0;
  let toolResult!: Promise<string>;
  const a = turns.run(A, async () => {
    const original = turns.capture();
    toolResult = approval.promise.then(() => { turns.assert(original); executed++; return 'executed'; }).catch(() => 'forbidden');
    await f.session.prompt('owned A'); returned.resolve();
  }, () => drain.createPiPromptEventDrain(f.session)());
  try {
    await returned.promise; await f.reached.promise;
    await turns.abortAndDrain(A, () => f.session.abort()); approval.resolve();
    expect(await toolResult).toBe('forbidden'); expect(executed).toBe(0);
    f.release(); await a;
  } finally { approval.resolve(); f.release(); await a.catch(() => {}); await f.cleanup(); }
});

it('missing pinned SDK queue fails closed instead of admitting the next prompt', async () => {
  const turns = new lifecycle.PromptTurnContexts() as SettlingTurns;
  await expect(turns.run(A, async () => {}, () => drain.createPiPromptEventDrain({ agent: { waitForIdle: async () => {} }, subscribe: () => () => {} } as unknown as AgentSession)())).rejects.toThrow('event queue');
});
