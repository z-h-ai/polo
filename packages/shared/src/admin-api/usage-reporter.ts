/**
 * Background usage retry timer and shared reporting logic.
 *
 * This module implements:
 * 1. `reportPendingEntry` — shared function used by both immediate reporting
 *    (T027) and the background retry timer (T028). Handles 200/409 removal
 *    and error/failure markRetry consistently.
 *
 * 2. `createUsageReporter` — factory for a retry timer object with
 *    start/stop/triggerTick/isRunning methods. Processes pending entries
 *    sequentially every 30 seconds (configurable for testing). Skips entries
 *    with retryCount >= 3. Prevents overlapping batches via a `processing` flag.
 *
 * 3. `startRetryTimer` / `stopRetryTimer` — module-level singleton lifecycle
 *    functions for integration with server startup/shutdown (headless-start.ts).
 *
 * Contract: spec-polo-ai.md §5.2, §6.2 (异步用量上报 + pending 重试)
 * Task: polo-quota.async-reporting
 */

import type { PendingUsageEntry } from './pending-usage.ts';

// ─── fetch type alias (consistent with client.ts) ─────────────────────────────

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum retry attempts before an entry is skipped (preserved for investigation). */
const MAX_RETRY_COUNT = 3;

/** Default timer interval in ms (30 seconds). */
const DEFAULT_INTERVAL_MS = 30_000;

// ─── Shared reporting deps ────────────────────────────────────────────────────

export interface ReportPendingEntryDeps {
  pendingStore: {
    remove(requestId: string): void;
    markRetry(requestId: string): void;
  };
  fetchFn: FetchFn;
  adminApiUrl: string;
}

/**
 * Report a single pending entry to Admin API.
 *
 * Shared by:
 * - Immediate fire-and-forget in T027 (captureAndReportUsage)
 * - Background retry timer in T028 (this module)
 *
 * Outcome table:
 * | Admin response | Action                    |
 * |----------------|---------------------------|
 * | 200            | remove from store         |
 * | 409 duplicate  | remove from store         |
 * | 401/500/network| markRetry (retryCount++)  |
 *
 * Never throws — all errors are caught internally.
 */
export async function reportPendingEntry(
  entry: PendingUsageEntry,
  deps: ReportPendingEntryDeps,
): Promise<void> {
  const { pendingStore, fetchFn, adminApiUrl } = deps;

  try {
    const response = await fetchFn(`${adminApiUrl}/api/quota/usage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${entry.userJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
      }),
    });

    if (response.ok) {
      // 200: successfully recorded — remove from pending store
      pendingStore.remove(entry.requestId);
    } else if (response.status === 409) {
      // 409: already recorded — safe to remove (duplicate)
      pendingStore.remove(entry.requestId);
    } else {
      // 401, 500, etc.: mark for retry
      pendingStore.markRetry(entry.requestId);
    }
  } catch {
    // Network failure / AbortError / any other error → mark for retry
    pendingStore.markRetry(entry.requestId);
  }
}

// ─── Usage reporter factory ───────────────────────────────────────────────────

export interface UsageReporterOptions {
  pendingStore: {
    getPendingEntries(): PendingUsageEntry[];
    remove(requestId: string): void;
    markRetry(requestId: string): void;
  };
  fetchFn: FetchFn;
  adminApiUrl: string;
  /** Timer interval in ms. Defaults to 30_000. */
  intervalMs?: number;
  /** Optional callback invoked after each entry is processed (for testing). */
  onEntryProcessed?: (requestId: string) => void;
}

export type UsageReporterDeps = UsageReporterOptions;

export interface UsageReporter {
  /** Start the background timer. No-op if already running. */
  start(): void;
  /** Stop the background timer. Safe to call multiple times. */
  stop(): void;
  /** Returns true if the timer is currently running. */
  isRunning(): boolean;
  /**
   * Manually trigger one retry tick.
   * Resolves when the tick finishes (or is skipped due to concurrency guard).
   * Used in tests to avoid real timers.
   */
  triggerTick(): Promise<void>;
}

/**
 * Create a usage reporter with background retry timer.
 *
 * Processing rules:
 * - Only entries with retryCount < MAX_RETRY_COUNT (3) are processed.
 * - Entries are processed sequentially (for...of) to avoid overwhelming Admin.
 * - A `processing` boolean flag prevents overlapping batches.
 */
export function createUsageReporter(options: UsageReporterOptions): UsageReporter {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let processing = false;

  const reportDeps: ReportPendingEntryDeps = {
    pendingStore: options.pendingStore,
    fetchFn: options.fetchFn,
    adminApiUrl: options.adminApiUrl,
  };

  /**
   * Process one batch of pending entries.
   * Skips if another batch is already in progress (concurrency guard).
   */
  async function runBatch(): Promise<void> {
    // Concurrency guard: skip tick if previous is still running
    if (processing) {
      return;
    }

    processing = true;
    try {
      const entries = options.pendingStore.getPendingEntries();

      // Sequential processing — do NOT use Promise.all
      for (const entry of entries) {
        // Skip entries that have exceeded max retry count
        if (entry.retryCount >= MAX_RETRY_COUNT) {
          continue;
        }

        await reportPendingEntry(entry, reportDeps);

        options.onEntryProcessed?.(entry.requestId);
      }
    } finally {
      processing = false;
    }
  }

  return {
    start() {
      if (intervalId !== undefined) return;
      intervalId = setInterval(() => {
        // Fire-and-forget: errors are caught inside runBatch
        void runBatch();
      }, intervalMs);
    },

    stop() {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    },

    isRunning() {
      return intervalId !== undefined;
    },

    async triggerTick() {
      await runBatch();
    },
  };
}

// ─── Module-level singleton (for headless-start.ts integration) ───────────────

let _globalReporter: UsageReporter | undefined;

/**
 * Start the global background retry timer.
 *
 * Called during server startup (headless-start.ts `bootstrapServer`).
 * If a timer is already running, it is stopped and replaced.
 */
export function startRetryTimer(options: UsageReporterOptions): void {
  // Stop any existing timer to prevent leaks
  if (_globalReporter) {
    _globalReporter.stop();
    _globalReporter = undefined;
  }

  _globalReporter = createUsageReporter(options);
  _globalReporter.start();
}

/**
 * Stop the global background retry timer.
 *
 * Called during graceful shutdown (headless-start.ts `stop`).
 * Safe to call multiple times.
 */
export function stopRetryTimer(): void {
  if (_globalReporter) {
    _globalReporter.stop();
    _globalReporter = undefined;
  }
}
