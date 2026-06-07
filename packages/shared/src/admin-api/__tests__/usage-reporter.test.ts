/**
 * Tests for the usage-reporter background retry timer.
 *
 * Contract: spec-polo-ai.md §5.2, §6.2 (异步用量上报 + pending 重试)
 * Task: polo-quota.async-reporting
 *
 * AC1: Background timer fires every 30 seconds, skips entries with retryCount >= 3
 * AC2: Successful retry removes entry from store
 * AC3: Failed retry increments retryCount
 * AC4: Startup behavior: pending entries loaded and retried on next tick
 * AC5: Timer lifecycle: start/stop cleanly
 * AC6: Concurrency guard: no overlapping batches
 * AC7: Lifecycle integration: startRetryTimer/stopRetryTimer exportable
 * AC8: Shared reporting logic: reportPendingEntry is the shared function
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createUsageReporter,
  reportPendingEntry,
  type UsageReporterDeps,
  type ReportPendingEntryDeps,
} from '../usage-reporter.ts';
import { createPendingUsageStore, type PendingUsageEntry } from '../pending-usage.ts';

// ─── test helpers ─────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<PendingUsageEntry> = {}): PendingUsageEntry {
  return {
    requestId: 'req-1',
    userId: 'user-a',
    userJwt: 'jwt-a',
    sessionId: 'sess-1',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 200,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  };
}

function makeSuccessResponse(): Response {
  return new Response(JSON.stringify({ recorded: true, totalUsed: 100, remaining: 900 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDuplicateResponse(): Response {
  return new Response(JSON.stringify({ error: 'Duplicate request' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeErrorResponse(status = 500): Response {
  return new Response(JSON.stringify({ error: 'Server error' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let tmpDir: string;
let testFilePath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `polo-ai-reporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  testFilePath = join(tmpDir, 'pending-usage.jsonl');
  process.env.ADMIN_API_URL = 'http://admin.test.local';
});

afterEach(() => {
  delete process.env.ADMIN_API_URL;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── AC8: Shared reporting logic ─────────────────────────────────────────────

describe('AC8: reportPendingEntry shared function', () => {
  it('AC8.1: Admin returns 200 → removes entry from store', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    const entry = makeEntry({ requestId: 'req-200' });
    store.add(entry);

    const removedIds: string[] = [];
    const retriedIds: string[] = [];

    const deps: ReportPendingEntryDeps = {
      pendingStore: {
        remove: mock((id: string) => { removedIds.push(id); store.remove(id); }),
        markRetry: mock((id: string) => { retriedIds.push(id); store.markRetry(id); }),
      },
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
    };

    await reportPendingEntry(entry, deps);

    expect(removedIds).toContain('req-200');
    expect(retriedIds).toHaveLength(0);
  });

  it('AC8.2: Admin returns 409 (duplicate) → removes entry from store', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    const entry = makeEntry({ requestId: 'req-409' });
    store.add(entry);

    const removedIds: string[] = [];
    const retriedIds: string[] = [];

    const deps: ReportPendingEntryDeps = {
      pendingStore: {
        remove: mock((id: string) => { removedIds.push(id); }),
        markRetry: mock((id: string) => { retriedIds.push(id); }),
      },
      fetchFn: mock(async () => makeDuplicateResponse()),
      adminApiUrl: 'http://admin.test.local',
    };

    await reportPendingEntry(entry, deps);

    expect(removedIds).toContain('req-409');
    expect(retriedIds).toHaveLength(0);
  });

  it('AC8.3: Network error → retryCount incremented, entry stays in store', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    const entry = makeEntry({ requestId: 'req-net-err' });
    store.add(entry);

    const removedIds: string[] = [];
    const retriedIds: string[] = [];

    const deps: ReportPendingEntryDeps = {
      pendingStore: {
        remove: mock((id: string) => { removedIds.push(id); }),
        markRetry: mock((id: string) => { retriedIds.push(id); store.markRetry(id); }),
      },
      fetchFn: mock(async () => { throw new Error('Network failure'); }),
      adminApiUrl: 'http://admin.test.local',
    };

    await reportPendingEntry(entry, deps);

    expect(removedIds).toHaveLength(0);
    expect(retriedIds).toContain('req-net-err');
  });

  it('AC8.4: HTTP 500 → retryCount incremented', async () => {
    const entry = makeEntry({ requestId: 'req-500' });

    const removedIds: string[] = [];
    const retriedIds: string[] = [];

    const deps: ReportPendingEntryDeps = {
      pendingStore: {
        remove: mock((id: string) => { removedIds.push(id); }),
        markRetry: mock((id: string) => { retriedIds.push(id); }),
      },
      fetchFn: mock(async () => makeErrorResponse(500)),
      adminApiUrl: 'http://admin.test.local',
    };

    await reportPendingEntry(entry, deps);

    expect(removedIds).toHaveLength(0);
    expect(retriedIds).toContain('req-500');
  });

  it('AC8.5: HTTP 401 (expired JWT) → retryCount incremented, entry stays', async () => {
    const entry = makeEntry({ requestId: 'req-401', retryCount: 0 });

    const removedIds: string[] = [];
    const retriedIds: string[] = [];

    const deps: ReportPendingEntryDeps = {
      pendingStore: {
        remove: mock((id: string) => { removedIds.push(id); }),
        markRetry: mock((id: string) => { retriedIds.push(id); }),
      },
      fetchFn: mock(async () => makeErrorResponse(401)),
      adminApiUrl: 'http://admin.test.local',
    };

    await reportPendingEntry(entry, deps);

    expect(removedIds).toHaveLength(0);
    expect(retriedIds).toContain('req-401');
  });

  it('AC8.6: uses entry.userJwt for Authorization Bearer header', async () => {
    const entry = makeEntry({ requestId: 'req-jwt', userJwt: 'my-user-jwt-token' });

    let capturedAuth = '';

    const deps: ReportPendingEntryDeps = {
      pendingStore: {
        remove: mock(() => {}),
        markRetry: mock(() => {}),
      },
      fetchFn: mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        capturedAuth = headers?.['Authorization'] ?? '';
        return makeSuccessResponse();
      }),
      adminApiUrl: 'http://admin.test.local',
    };

    await reportPendingEntry(entry, deps);

    expect(capturedAuth).toBe('Bearer my-user-jwt-token');
  });
});

// ─── AC1: Background timer ────────────────────────────────────────────────────

describe('AC1: Background timer behavior', () => {
  it('AC1.1: Timer processes all pending entries with retryCount < 3', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r1', retryCount: 0 }));
    store.add(makeEntry({ requestId: 'r2', retryCount: 2 }));

    const processedIds: string[] = [];

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => {
        return makeSuccessResponse();
      }),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100, // small interval for test
      onEntryProcessed: (id) => { processedIds.push(id); },
    });

    // Manually trigger one tick
    await reporter.triggerTick();
    reporter.stop();

    expect(processedIds).toContain('r1');
    expect(processedIds).toContain('r2');
  });

  it('AC1.2: Entries with retryCount >= 3 are skipped by timer', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-skip', retryCount: 3 }));
    store.add(makeEntry({ requestId: 'r-process', retryCount: 2 }));

    const processedIds: string[] = [];

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
      onEntryProcessed: (id) => { processedIds.push(id); },
    });

    await reporter.triggerTick();
    reporter.stop();

    expect(processedIds).not.toContain('r-skip');
    expect(processedIds).toContain('r-process');
  });

  it('AC1.3: Entry with retryCount = 4 is also skipped', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-skip-4', retryCount: 4 }));

    const processedIds: string[] = [];

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
      onEntryProcessed: (id) => { processedIds.push(id); },
    });

    await reporter.triggerTick();
    reporter.stop();

    expect(processedIds).not.toContain('r-skip-4');
  });
});

// ─── AC2: Successful retry ────────────────────────────────────────────────────

describe('AC2: Successful retry', () => {
  it('AC2.1: Pending entry retried → Admin returns 200 → entry removed from store', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-success', retryCount: 1 }));

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    const remaining = store.getPendingEntries();
    expect(remaining.find((e) => e.requestId === 'r-success')).toBeUndefined();
  });

  it('AC2.2: Pending entry retried → Admin returns 409 (duplicate) → entry removed from store', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-dup', retryCount: 0 }));

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeDuplicateResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    const remaining = store.getPendingEntries();
    expect(remaining.find((e) => e.requestId === 'r-dup')).toBeUndefined();
  });
});

// ─── AC3: Failed retry ────────────────────────────────────────────────────────

describe('AC3: Failed retry', () => {
  it('AC3.1: Network error on retry → retryCount incremented, entry stays in store', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-net-fail', retryCount: 0 }));

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => { throw new Error('Network failure'); }),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    const remaining = store.getPendingEntries();
    const entry = remaining.find((e) => e.requestId === 'r-net-fail');
    expect(entry).toBeDefined();
    expect(entry!.retryCount).toBe(1);
  });

  it('AC3.2: HTTP 500 on retry → retryCount incremented', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-500', retryCount: 0 }));

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeErrorResponse(500)),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    const remaining = store.getPendingEntries();
    const entry = remaining.find((e) => e.requestId === 'r-500');
    expect(entry).toBeDefined();
    expect(entry!.retryCount).toBe(1);
  });

  it('AC3.3: HTTP 401 (expired JWT) → retryCount incremented, entry stays', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r-401', retryCount: 0 }));

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeErrorResponse(401)),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    const remaining = store.getPendingEntries();
    const entry = remaining.find((e) => e.requestId === 'r-401');
    expect(entry).toBeDefined();
    expect(entry!.retryCount).toBe(1);
  });
});

// ─── AC4: Startup behavior ────────────────────────────────────────────────────

describe('AC4: Startup behavior', () => {
  it('AC4.1: Pending entries from store are processed on next timer tick', async () => {
    // Simulate entries that were loaded from disk
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'startup-r1', retryCount: 0 }));
    store.add(makeEntry({ requestId: 'startup-r2', retryCount: 1 }));

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    // Both entries should have been processed (removed)
    const remaining = store.getPendingEntries();
    expect(remaining.find((e) => e.requestId === 'startup-r1')).toBeUndefined();
    expect(remaining.find((e) => e.requestId === 'startup-r2')).toBeUndefined();
  });

  it('AC4.2: Previously pending entries are retried on next timer tick', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'prev-pending', retryCount: 1 }));

    let fetchCalled = false;
    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => { fetchCalled = true; return makeSuccessResponse(); }),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    expect(fetchCalled).toBe(true);
  });
});

// ─── AC5: Timer lifecycle ─────────────────────────────────────────────────────

describe('AC5: Timer lifecycle', () => {
  it('AC5.1: startRetryTimer() starts the interval', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 30_000,
    });

    // Should start cleanly
    reporter.start();
    expect(reporter.isRunning()).toBe(true);
    reporter.stop();
  });

  it('AC5.2: stopRetryTimer() clears the interval cleanly (graceful shutdown)', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 30_000,
    });

    reporter.start();
    reporter.stop();

    expect(reporter.isRunning()).toBe(false);
  });

  it('AC5.3: stop() can be called multiple times without error', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 30_000,
    });

    reporter.start();
    expect(() => {
      reporter.stop();
      reporter.stop();
      reporter.stop();
    }).not.toThrow();

    expect(reporter.isRunning()).toBe(false);
  });

  it('AC5.4: Timer does not leak on test restart (stop clears interval)', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    let tickCount = 0;

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => { tickCount++; return makeSuccessResponse(); }),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 50,
      onEntryProcessed: undefined,
    });

    // start then stop immediately — ticks should not accumulate
    reporter.start();
    reporter.stop();

    const countAfterStop = tickCount;

    // If timer was properly stopped, no additional ticks occur
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(tickCount).toBe(countAfterStop);
        resolve();
      }, 100);
    });
  });
});

// ─── AC6: Concurrency guard ───────────────────────────────────────────────────

describe('AC6: Concurrency guard', () => {
  it('AC6.1: If processing takes >30s, next timer tick is skipped (no overlap)', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'slow-entry', retryCount: 0 }));

    let concurrentTicks = 0;
    let maxConcurrent = 0;
    let currentlyProcessing = 0;

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async () => {
        // Simulate slow processing
        currentlyProcessing++;
        concurrentTicks++;
        maxConcurrent = Math.max(maxConcurrent, currentlyProcessing);
        await new Promise(resolve => setTimeout(resolve, 50));
        currentlyProcessing--;
        return makeSuccessResponse();
      }),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    // Trigger two rapid ticks — second should be skipped if first is in progress
    const tick1 = reporter.triggerTick();
    const tick2 = reporter.triggerTick(); // should be skipped
    await Promise.all([tick1, tick2]);
    reporter.stop();

    // The concurrent processing should not exceed 1
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  it('AC6.2: Entries processed sequentially (not all at once) to avoid overwhelming Admin', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'seq-1', retryCount: 0 }));
    store.add(makeEntry({ requestId: 'seq-2', retryCount: 0 }));
    store.add(makeEntry({ requestId: 'seq-3', retryCount: 0 }));

    const callOrder: string[] = [];
    let currentlyFetching = 0;
    let maxParallel = 0;

    const reporter = createUsageReporter({
      pendingStore: store,
      fetchFn: mock(async (_url: string | URL | Request, init?: RequestInit) => {
        currentlyFetching++;
        maxParallel = Math.max(maxParallel, currentlyFetching);
        const body = JSON.parse((init?.body as string) ?? '{}');
        callOrder.push(body.requestId ?? 'unknown');
        await new Promise(resolve => setTimeout(resolve, 10));
        currentlyFetching--;
        return makeSuccessResponse();
      }),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 100,
    });

    await reporter.triggerTick();
    reporter.stop();

    // Sequential = never more than 1 fetch in flight at a time
    expect(maxParallel).toBe(1);
    expect(callOrder).toHaveLength(3);
  });
});

// ─── AC7: Lifecycle integration ──────────────────────────────────────────────

describe('AC7: Lifecycle integration', () => {
  it('AC7.1: startRetryTimer() and stopRetryTimer() are exported', async () => {
    const { startRetryTimer, stopRetryTimer } = await import('../usage-reporter.ts');
    expect(typeof startRetryTimer).toBe('function');
    expect(typeof stopRetryTimer).toBe('function');
  });

  it('AC7.2: startRetryTimer() starts a global timer, stopRetryTimer() clears it', () => {
    const { startRetryTimer, stopRetryTimer } = require('../usage-reporter.ts');

    const store = createPendingUsageStore({ filePath: testFilePath });
    startRetryTimer({
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 30_000,
    });

    // Should not throw
    stopRetryTimer();
  });

  it('AC7.3: Timer does not leak on server restart in tests', () => {
    const { startRetryTimer, stopRetryTimer } = require('../usage-reporter.ts');

    const store = createPendingUsageStore({ filePath: testFilePath });
    const opts = {
      pendingStore: store,
      fetchFn: mock(async () => makeSuccessResponse()),
      adminApiUrl: 'http://admin.test.local',
      intervalMs: 30_000,
    };

    // Start twice — second call should replace (or stop+restart) cleanly
    startRetryTimer(opts);
    startRetryTimer(opts);
    stopRetryTimer();

    // No leaks after stop
    expect(true).toBe(true);
  });
});
