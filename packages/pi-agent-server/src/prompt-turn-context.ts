import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

export interface PromptTurnContext { readonly turnId: string; closed: boolean }

/** A queued prompt keeps its producer identity through every SDK/tool await. */
export class PromptTurnContexts {
  private storage = new AsyncLocalStorage<PromptTurnContext>();
  private contexts = new Set<PromptTurnContext>();
  private tail: Promise<void> = Promise.resolve();
  private active: PromptTurnContext | null = null;

  run<T>(turnId: string, operation: () => Promise<T>, settle?: () => Promise<void>): Promise<T> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(turnId)) return Promise.reject(new Error('Missing original prompt turn identity'));
    const context = { turnId, closed: false };
    this.contexts.add(context);
    const result = this.tail.then(() => this.storage.run(context, async () => {
      try { this.assert(context); this.active = context; return await operation(); }
      finally {
        // SDK prompt completion can precede its queued terminal events. Keep
        // this original identity and FIFO slot until that producer is drained.
        try { await settle?.(); }
        finally { context.closed = true; this.contexts.delete(context); if (this.active === context) this.active = null; }
      }
    }));
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  capture(): PromptTurnContext {
    const context = this.storage.getStore();
    if (!context) throw new Error('Tool has no original prompt turn identity');
    this.assert(context);
    return context;
  }

  assert(context: PromptTurnContext, signal?: AbortSignal): void {
    if (context.closed || !this.contexts.has(context) || signal?.aborted) throw new Error('The original prompt turn was ended or aborted');
  }

  abort(): void { for (const context of this.contexts) context.closed = true; }

  /** An old abort cannot cancel B; B also cannot start until A's SDK abort settles. */
  async abortAndDrain(turnId: string | undefined, operation: () => Promise<void>): Promise<void> {
    if (turnId && ![...this.contexts].some(context => context.turnId === turnId)) return;
    if (turnId) { for (const context of this.contexts) if (context.turnId === turnId) context.closed = true; }
    else this.abort();
    if (turnId && this.active?.turnId !== turnId) return;
    const draining = operation();
    this.tail = Promise.allSettled([this.tail, draining]).then(() => {});
    await draining;
  }
}

/** Pi 0.73.1 has no public event-queue drain. Its prompt()/abort() await core
 * generation, while AgentSession asynchronously dispatches/persists its events.
 * Keep this pinned private compatibility boundary narrow and fail closed when
 * an SDK upgrade changes it. Construct before prompting to observe deferred
 * compaction/retry continuations; call once in the original turn's finally. */
export function createPiPromptEventDrain(session: Pick<AgentSession, 'agent' | 'subscribe' | 'clearQueue' | 'abortCompaction'>, assertActive?: () => void): () => Promise<void> {
  const queue = (): PromiseLike<unknown> => {
    const value = (session as unknown as { _agentEventQueue?: PromiseLike<unknown> })._agentEventQueue;
    if (!value || typeof value.then !== 'function') throw new Error('Pinned Pi SDK event queue is unavailable');
    return value;
  };
  queue();
  let continuation = false, retry = false;
  let wake: (() => void) | undefined;
  const notify = () => { const listener = wake; wake = undefined; listener?.(); };
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'compaction_end') {
      // Pi also schedules continue after successful threshold compaction when
      // steer/follow-up arrived during compaction, even with willRetry=false.
      continuation = Boolean(event.result) && !event.aborted && (event.willRetry || session.agent.hasQueuedMessages());
    }
    if (event.type === 'agent_start') continuation = false;
    if (event.type === 'auto_retry_start') retry = true;
    if (event.type === 'auto_retry_end') retry = false;
    notify();
  });
  const originalContinue = session.agent.continue;
  const guardedContinue: typeof originalContinue = function (this: AgentSession['agent'], ...args) {
    try { assertActive?.(); }
    catch (error) {
      // SDK abort() does not cancel its already scheduled continuation timer.
      // Reject that original timer before it can dispatch another model call,
      // then release its FIFO slot. Never restore early and let it borrow B.
      session.abortCompaction();
      session.clearQueue();
      continuation = false; retry = false; notify();
      return Promise.reject(error);
    }
    return originalContinue.apply(this, args);
  };
  session.agent.continue = guardedContinue;
  return async () => {
    try {
      for (;;) {
        const pending = queue();
        await pending;
        await session.agent.waitForIdle();
        // Events or a continuation can enqueue during either await. A single
        // snapshot (or the first agent_end) is not the producer's final drain.
        if (pending !== queue()) continue;
        if (!continuation && !retry) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      unsubscribe();
      if (session.agent.continue === guardedContinue) session.agent.continue = originalContinue;
    }
  };
}
