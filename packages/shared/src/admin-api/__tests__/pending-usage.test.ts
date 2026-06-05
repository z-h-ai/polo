/**
 * Tests for the pending_usage JSONL store.
 *
 * Contract: spec-polo-ai.md §6.2 (Pending Usage Store)
 *
 * Important: CONFIG_DIR is evaluated at module load time, so we must use
 * a custom filePath via createPendingUsageStore() for test isolation,
 * rather than setting POLO_AI_CONFIG_DIR after import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

let tmpDir: string;
let testFilePath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `polo-ai-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  testFilePath = join(tmpDir, 'pending-usage.jsonl');
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── AC1: add(entry) ──────────────────────────────────────────────────────────

describe('AC1: add(entry)', () => {
  it('appends a JSON line to the JSONL file on disk', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    const entry = makeEntry();
    store.add(entry);

    expect(existsSync(testFilePath)).toBe(true);
    const content = await Bun.file(testFilePath).text();
    const firstLine = content.trim().split('\n')[0] ?? '';
    const parsed = JSON.parse(firstLine);
    expect(parsed.requestId).toBe('req-1');
  });

  it('entry is immediately available in memory via getPendingEntries()', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    const entry = makeEntry();
    store.add(entry);

    const entries = store.getPendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.requestId).toBe('req-1');
  });

  it('entry has all required fields with retryCount=0 by default', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    const entry = makeEntry();
    store.add(entry);

    const stored = store.getPendingEntries()[0]!;
    expect(stored).toHaveProperty('requestId');
    expect(stored).toHaveProperty('userId');
    expect(stored).toHaveProperty('userJwt');
    expect(stored).toHaveProperty('sessionId');
    expect(stored).toHaveProperty('model');
    expect(stored).toHaveProperty('inputTokens');
    expect(stored).toHaveProperty('outputTokens');
    expect(stored).toHaveProperty('createdAt');
    expect(stored.retryCount).toBe(0);
  });

  it('file survives process restart (data can be read back from disk)', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-persist' }));

    // Create a new store instance pointing to the same file (simulates restart)
    const store2 = createPendingUsageStore({ filePath: testFilePath });
    const entries = store2.getPendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.requestId).toBe('req-persist');
  });

  it('deduplicates entries with the same requestId (overwrites)', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-dup', inputTokens: 100 }));
    store.add(makeEntry({ requestId: 'req-dup', inputTokens: 999 }));

    const entries = store.getPendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.inputTokens).toBe(999);
  });
});

// ─── AC2: remove(requestId) ───────────────────────────────────────────────────

describe('AC2: remove(requestId)', () => {
  it('removes entry from memory', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1' }));
    store.add(makeEntry({ requestId: 'req-2' }));

    store.remove('req-1');

    const entries = store.getPendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.requestId).toBe('req-2');
  });

  it('rewrites JSONL file after removal', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1' }));
    store.add(makeEntry({ requestId: 'req-2' }));

    store.remove('req-1');

    const content = await Bun.file(testFilePath).text();
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '');
    expect(parsed.requestId).toBe('req-2');
  });

  it('removed entry is no longer in getPendingEntries()', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1' }));
    store.remove('req-1');

    const entries = store.getPendingEntries();
    expect(entries.find((e) => e.requestId === 'req-1')).toBeUndefined();
  });

  it('remove("nonexistent") does not throw', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    expect(() => store.remove('nonexistent')).not.toThrow();
  });
});

// ─── AC3: getPendingTokens(userId) ────────────────────────────────────────────

describe('AC3: getPendingTokens(userId)', () => {
  it('returns sum of (inputTokens + outputTokens) for all pending entries of that userId', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1', userId: 'user-a', inputTokens: 100, outputTokens: 200 }));
    store.add(makeEntry({ requestId: 'req-2', userId: 'user-a', inputTokens: 300, outputTokens: 400 }));
    store.add(makeEntry({ requestId: 'req-3', userId: 'user-b', inputTokens: 999, outputTokens: 999 }));

    expect(store.getPendingTokens('user-a')).toBe(100 + 200 + 300 + 400);
  });

  it('userId with no entries → returns 0', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    expect(store.getPendingTokens('user-unknown')).toBe(0);
  });

  it('3 entries for user-a with tokens [100+200, 300+400, 500+600] → returns 2100', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'r1', userId: 'user-a', inputTokens: 100, outputTokens: 200 }));
    store.add(makeEntry({ requestId: 'r2', userId: 'user-a', inputTokens: 300, outputTokens: 400 }));
    store.add(makeEntry({ requestId: 'r3', userId: 'user-a', inputTokens: 500, outputTokens: 600 }));

    expect(store.getPendingTokens('user-a')).toBe(2100);
  });
});

// ─── AC4: markRetry(requestId) ────────────────────────────────────────────────

describe('AC4: markRetry(requestId)', () => {
  it('increments retryCount for the entry in memory', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1', retryCount: 0 }));

    store.markRetry('req-1');

    const entry = store.getPendingEntries().find((e) => e.requestId === 'req-1');
    expect(entry?.retryCount).toBe(1);
  });

  it('increments retryCount multiple times', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1', retryCount: 2 }));

    store.markRetry('req-1');

    const entry = store.getPendingEntries().find((e) => e.requestId === 'req-1');
    expect(entry?.retryCount).toBe(3);
  });

  it('persists incremented retryCount to disk', async () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1', retryCount: 0 }));

    store.markRetry('req-1');

    const content = await Bun.file(testFilePath).text();
    const parsed = JSON.parse(content.trim().split('\n')[0] ?? '');
    expect(parsed.retryCount).toBe(1);
  });

  it('markRetry on nonexistent requestId does not throw', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    expect(() => store.markRetry('nonexistent')).not.toThrow();
  });
});

// ─── AC5: getPendingEntries() ─────────────────────────────────────────────────

describe('AC5: getPendingEntries()', () => {
  it('returns all entries as an array', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    store.add(makeEntry({ requestId: 'req-1' }));
    store.add(makeEntry({ requestId: 'req-2' }));

    const entries = store.getPendingEntries();
    expect(entries).toHaveLength(2);
  });

  it('empty store → returns []', () => {
    const store = createPendingUsageStore({ filePath: testFilePath });
    expect(store.getPendingEntries()).toEqual([]);
  });
});

// ─── AC6: Startup loading ─────────────────────────────────────────────────────

describe('AC6: Startup loading', () => {
  it('on init, loads all entries from existing JSONL file into memory', () => {
    const entry1 = makeEntry({ requestId: 'req-1' });
    const entry2 = makeEntry({ requestId: 'req-2' });
    writeFileSync(testFilePath, `${JSON.stringify(entry1)}\n${JSON.stringify(entry2)}\n`);

    const store = createPendingUsageStore({ filePath: testFilePath });
    const entries = store.getPendingEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.requestId).sort()).toEqual(['req-1', 'req-2']);
  });

  it('missing JSONL file → starts empty (no error)', () => {
    // testFilePath does not exist yet
    const store = createPendingUsageStore({ filePath: testFilePath });
    expect(store.getPendingEntries()).toEqual([]);
  });

  it('empty JSONL file → starts empty', () => {
    writeFileSync(testFilePath, '');

    const store = createPendingUsageStore({ filePath: testFilePath });
    expect(store.getPendingEntries()).toEqual([]);
  });

  it('corrupted JSONL line → skips that line, loads valid lines', () => {
    const valid = makeEntry({ requestId: 'req-good' });
    writeFileSync(testFilePath, `${JSON.stringify(valid)}\nthis is not json\n`);

    const store = createPendingUsageStore({ filePath: testFilePath });
    const entries = store.getPendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.requestId).toBe('req-good');
  });
});
