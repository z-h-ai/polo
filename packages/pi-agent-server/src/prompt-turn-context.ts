import { AsyncLocalStorage } from 'node:async_hooks';

export interface PromptTurnContext { readonly turnId: string; closed: boolean }

/** A queued prompt keeps its producer identity through every SDK/tool await. */
export class PromptTurnContexts {
  private storage = new AsyncLocalStorage<PromptTurnContext>();
  private contexts = new Set<PromptTurnContext>();
  private tail: Promise<void> = Promise.resolve();
  private active: PromptTurnContext | null = null;

  run<T>(turnId: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(turnId)) return Promise.reject(new Error('Missing original prompt turn identity'));
    const context = { turnId, closed: false };
    this.contexts.add(context);
    const result = this.tail.then(() => this.storage.run(context, async () => {
      try { this.assert(context); this.active = context; return await operation(); }
      finally { context.closed = true; this.contexts.delete(context); if (this.active === context) this.active = null; }
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
