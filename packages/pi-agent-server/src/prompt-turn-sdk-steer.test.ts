import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, AuthStorage, SessionManager, SettingsManager, type AgentSession } from '@mariozechner/pi-coding-agent';
import { createAssistantMessageEventStream, getModel } from '@mariozechner/pi-ai';
import { PromptTurnContexts, createPiPromptEventDrain } from './prompt-turn-context.ts';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const STEER = 'owned A queued steering content';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned SDK continuation did not settle')), 2500); })]); } finally { clearTimeout(timer); } }
async function timerWindow() { let timer: ReturnType<typeof setTimeout> | undefined; try { await new Promise<void>(resolve => { timer = setTimeout(resolve, 180); }); } finally { clearTimeout(timer); } }
const guardedDrain = createPiPromptEventDrain as (session: AgentSession, assertActive: () => void) => () => Promise<void>;
async function fixture(turns: PromptTurnContexts) {
  const directory = mkdtempSync(join(tmpdir(), 'polo-pi-steer-drain-')), compaction = deferred(), continued = deferred();
  const requests: Array<{ turnId: string; content: string }> = [], order: string[] = [];
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 16 } });
  const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey('openai', 'owned-stream-only-no-network');
  let session!: AgentSession;
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true,
    extensionFactories: [pi => { pi.on('session_before_compact', async event => {
      await session.steer(STEER);
      return { compaction: { summary: 'owned extension summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    }); }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager: settings, authStorage: auth, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), model: { ...getModel('openai', 'gpt-4o'), contextWindow: 256 }, tools: [] }));
  session.agent.streamFn = (_model, context) => {
    let turnId = 'closed'; try { turnId = turns.capture().turnId; } catch {}
    requests.push({ turnId, content: JSON.stringify(context.messages) }); const count = requests.length;
    const stream = createAssistantMessageEventStream(); queueMicrotask(() => {
      const message = { role: 'assistant' as const, api: 'openai-completions' as const, provider: 'openai', model: 'gpt-4o', content: [{ type: 'text' as const, text: `owned reply ${count}` }], usage: { input: count === 1 ? 210 : 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: count === 1 ? 211 : 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() };
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(message);
    }); return stream;
  };
  session.subscribe(event => {
    if (event.type === 'compaction_end' && event.result && !event.aborted) { expect(event.willRetry).toBe(false); expect(session.agent.hasQueuedMessages()).toBe(true); compaction.resolve(); }
    if (event.type === 'agent_end' && requests.length === 2) continued.resolve();
  });
  return { session, requests, order, compaction, continued, async cleanup() { session.abortCompaction(); session.clearQueue(); await session.abort(); await timerWindow(); await (session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue; session.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}

it('real threshold compaction with queued steer keeps A terminal tail before B subscription', async () => {
  const turns = new PromptTurnContexts(), f = await fixture(turns); let finish: (() => Promise<void>) | undefined;
  const a = turns.run(A, async () => {
    const original = turns.capture(); finish = guardedDrain(f.session, () => turns.assert(original));
    f.session.subscribe(event => { try { turns.assert(original); } catch { return; } if (event.type === 'agent_end') f.order.push('A:agent_end'); });
    await f.session.prompt('owned A');
  }, async () => { await finish?.(); });
  let b: Promise<void> | undefined;
  try {
    await bounded(f.compaction.promise);
    b = turns.run(B, async () => { f.order.push('B:subscribed'); });
    await bounded(f.continued.promise); await bounded(Promise.all([a, b]));
    expect(f.requests.map(request => request.turnId)).toEqual([A, A]);
    expect(f.order).toEqual(['A:agent_end', 'A:agent_end', 'B:subscribed']);
  } finally { await f.cleanup(); await bounded(Promise.allSettled([a, b])); }
});

it('abort in the real 100ms continuation gap sends no A model request and no A steer into normal B', async () => {
  const turns = new PromptTurnContexts(), f = await fixture(turns), allowB = deferred(); let finishA: (() => Promise<void>) | undefined, finishB: (() => Promise<void>) | undefined;
  const a = turns.run(A, async () => { const original = turns.capture(); finishA = guardedDrain(f.session, () => turns.assert(original)); await f.session.prompt('owned A'); }, async () => { await finishA?.(); });
  let b: Promise<void> | undefined;
  try {
    await bounded(f.compaction.promise);
    await turns.abortAndDrain(A, () => f.session.abort());
    b = turns.run(B, async () => { await allowB.promise; const original = turns.capture(); finishB = guardedDrain(f.session, () => turns.assert(original)); await f.session.prompt('owned B'); }, async () => { await finishB?.(); });
    // Wait beyond the SDK's real 100ms timer while B cannot issue a request.
    // This constrains the provider boundary, not only a late tool approval.
    await timerWindow();
    expect(f.requests).toHaveLength(1);
    allowB.resolve(); await bounded(Promise.all([a, b]));
    expect(f.requests.map(request => request.turnId)).toEqual([A, B]);
    expect(f.requests[1]!.content).not.toContain(STEER);
    expect(f.session.agent.hasQueuedMessages()).toBe(false);
  } finally { allowB.resolve(); await f.cleanup(); await bounded(Promise.allSettled([a, b])); }
});
