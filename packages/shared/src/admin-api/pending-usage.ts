/**
 * Pending Usage JSONL store.
 *
 * Local JSONL-file-backed queue for usage reports that have not yet been
 * successfully sent to Admin API. Entries are counted against quota locally
 * to prevent overspend.
 *
 * Contract: spec-polo-ai.md §6.2 (Pending Usage Store)
 *
 * Storage format: one JSON object per line, newline-terminated.
 * Internal storage: Map<string, PendingUsageEntry> keyed by requestId (O(1) lookups).
 *
 * Note: CONFIG_DIR is evaluated at module load time; production singleton uses
 * the resolved path. For test isolation, use createPendingUsageStore({ filePath }).
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { join } from 'path';
import { homedir } from 'os';

// ─── CONFIG_DIR resolution ────────────────────────────────────────────────────

const CONFIG_DIR = process.env.POLO_AI_CONFIG_DIR ?? join(homedir(), '.polo-ai');
const DEFAULT_FILE_PATH = join(CONFIG_DIR, 'pending-usage.jsonl');

// ─── types ────────────────────────────────────────────────────────────────────

export interface PendingUsageEntry {
  requestId: string;
  userId: string;
  userJwt: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  retryCount: number;
}

export interface PendingUsageStoreOptions {
  /** Override the file path (for testing). Defaults to ~/.polo-ai/pending-usage.jsonl */
  filePath?: string;
}

// ─── store class ─────────────────────────────────────────────────────────────

export class PendingUsageStore {
  private readonly filePath: string;
  private readonly entries: Map<string, PendingUsageEntry>;

  constructor(options: PendingUsageStoreOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_FILE_PATH;
    this.entries = new Map();
    this._loadFromDisk();
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  private _loadFromDisk(): void {
    if (!existsSync(this.filePath)) {
      return;
    }

    let text: string;
    try {
      // Bun.file().text() is async; use synchronous readFileSync for constructor
      text = readFileSync(this.filePath, 'utf-8');
    } catch {
      // Unreadable file → start empty
      return;
    }

    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as PendingUsageEntry;
        if (entry.requestId) {
          this.entries.set(entry.requestId, entry);
        }
      } catch {
        // Corrupted line → skip + log warning
        console.warn(`[PendingUsageStore] Skipping corrupted JSONL line: ${line.slice(0, 80)}`);
      }
    }
  }

  private _rewriteToDisk(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const lines = Array.from(this.entries.values())
      .map((e) => JSON.stringify(e))
      .join('\n');

    Bun.write(this.filePath, lines.length > 0 ? `${lines}\n` : '');
  }

  private _appendToDisk(entry: PendingUsageEntry): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
  }

  // ─── public API ────────────────────────────────────────────────────────────

  /**
   * Add (or overwrite) an entry in the store.
   * - Deduplicates by requestId (last write wins).
   * - New entries: appended to file for efficiency.
   * - Overwrite: rewrites entire file.
   */
  add(entry: PendingUsageEntry): void {
    const isNew = !this.entries.has(entry.requestId);
    this.entries.set(entry.requestId, entry);

    if (isNew) {
      // Efficient append for new entries
      this._appendToDisk(entry);
    } else {
      // Must rewrite file to apply the overwrite
      this._rewriteToDisk();
    }
  }

  /**
   * Remove an entry by requestId.
   * - No-op if the requestId does not exist.
   * - Rewrites entire file after removal.
   */
  remove(requestId: string): void {
    if (!this.entries.has(requestId)) {
      return;
    }
    this.entries.delete(requestId);
    this._rewriteToDisk();
  }

  /**
   * Get all pending entries as an array.
   */
  getPendingEntries(): PendingUsageEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get total pending token count for a specific userId.
   * Returns sum of (inputTokens + outputTokens) across all matching entries.
   * Returns 0 if the userId has no pending entries.
   */
  getPendingTokens(userId: string): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.userId === userId) {
        total += entry.inputTokens + entry.outputTokens;
      }
    }
    return total;
  }

  /**
   * Increment the retryCount for an existing entry.
   * - No-op if the requestId does not exist.
   * - Persists the update to disk.
   */
  markRetry(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return;
    }
    entry.retryCount += 1;
    this.entries.set(requestId, entry);
    this._rewriteToDisk();
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

/**
 * Factory function for creating a new PendingUsageStore instance.
 * Useful for testing with a custom file path.
 */
export function createPendingUsageStore(options: PendingUsageStoreOptions = {}): PendingUsageStore {
  return new PendingUsageStore(options);
}

// ─── singleton ────────────────────────────────────────────────────────────────

/**
 * Default singleton instance.
 * Uses ~/.polo-ai/pending-usage.jsonl (or $POLO_AI_CONFIG_DIR/pending-usage.jsonl).
 */
export const pendingUsageStore = new PendingUsageStore();
