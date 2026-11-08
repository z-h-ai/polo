/**
 * POO-205 one-shot local session store migration.
 *
 * Beta hard-cut (Spec §6): legacy sessions live flat in
 * `{workspaceRoot}/sessions/{id}/`; project sessions must live in their own
 * physical store `{workspaceRoot}/project-sessions/{projectId}/sessions/{id}/`
 * (ProjectSessionStorage). This tool moves project-bound session directories
 * into their project store. It lives in the session storage layer — path
 * decisions never belong to the UI, and the move never rewrites message
 * payloads (the JSONL header travels with the directory untouched).
 *
 * Rules:
 * - dry-run by default; `commit` performs the moves;
 * - idempotent: sources already moved (or targets present) are skipped;
 * - journaled: every move is recorded in `.poo205-migration-journal.json`
 *   at the workspace root for reversibility/audit;
 * - fail-closed on ambiguity: a session whose projectId cannot be resolved
 *   via the mapping callback stays in the legacy root (the RPC boundary
 *   keeps it invisible, same as today's unattributed records).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ProjectSessionStorage } from './session-storage.ts';

/**
 * The JSONL first line serializes the full SessionConfig (superset of the
 * typed SessionHeader) — space stamps ride there. Read them from the raw
 * payload; the typed header intentionally exposes only UI-facing fields.
 */
interface MigrationStampView {
  id?: string;
  productSpaceId?: string;
  projectId?: string;
}

function readSessionStamps(sessionFile: string): MigrationStampView | null {
  try {
    const content = readFileSync(sessionFile, 'utf8');
    const firstLine = content.slice(0, content.indexOf('\n'));
    if (!firstLine) return null;
    return JSON.parse(firstLine) as MigrationStampView;
  } catch {
    return null;
  }
}

export interface ProjectStoreMigrationMove {
  sessionId: string;
  fromPath: string;
  toPath: string;
  projectId: string;
  productSpaceId?: string;
}

export interface ProjectStoreMigrationPlan {
  moves: ProjectStoreMigrationMove[];
  /** Sessions left in the legacy root: unattributed or unmappable. */
  skipped: Array<{ sessionId: string; reason: 'unattributed' | 'unmappable' | 'target_exists' }>;
}

export interface ProjectStoreMigrationOptions {
  workspaceRootPath: string;
  /**
   * Resolves the migration mapping for a session's space stamp (from the
   * admin GET /api/client/migrations/poo-205/mapping response). Returns the
   * new projectId, or null when the space has no upgraded project.
   */
  resolveProjectId: (productSpaceId: string) => string | null | undefined;
  /** Copy instead of move? Never for the beta cut; kept for test harnesses. */
  dryRun?: boolean;
}

const JOURNAL_NAME = '.poo205-migration-journal.json';

interface MigrationJournal {
  version: 1;
  executedAt: string;
  moves: ProjectStoreMigrationMove[];
}

function legacySessionsRoot(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'sessions');
}

function listLegacySessionDirs(workspaceRootPath: string): string[] {
  const root = legacySessionsRoot(workspaceRootPath);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirNames(root)) {
    const candidate = join(root, name);
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'session.jsonl'))) {
        out.push(candidate);
      }
    } catch {
      // Unreadable entry stays untouched.
    }
  }
  return out;
}

function readdirNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function planProjectStoreMigration(options: ProjectStoreMigrationOptions): ProjectStoreMigrationPlan {
  const { workspaceRootPath, resolveProjectId } = options;
  const moves: ProjectStoreMigrationMove[] = [];
  const skipped: ProjectStoreMigrationPlan['skipped'] = [];
  for (const dir of listLegacySessionDirs(workspaceRootPath)) {
    const sessionId = dir.split(/[\\/]/).pop()!;
    const stamps = readSessionStamps(join(dir, 'session.jsonl'));
    const productSpaceId = stamps?.productSpaceId;
    // Records already carrying the new binding are explicit; unattributed
    // (no space stamp) and unmappable stay in the legacy root, fail-closed.
    const projectId = stamps?.projectId ?? (productSpaceId ? resolveProjectId(productSpaceId) : null);
    if (!productSpaceId && !stamps?.projectId) {
      skipped.push({ sessionId, reason: 'unattributed' });
      continue;
    }
    if (!projectId) {
      skipped.push({ sessionId, reason: 'unmappable' });
      continue;
    }
    const store = new ProjectSessionStorage(projectId);
    const target = store.getSessionPath(workspaceRootPath, sessionId);
    if (existsSync(target)) {
      skipped.push({ sessionId, reason: 'target_exists' });
      continue;
    }
    moves.push({
      sessionId,
      fromPath: dir,
      toPath: target,
      projectId,
      productSpaceId,
    });
  }
  return { moves, skipped };
}

export function commitProjectStoreMigration(options: ProjectStoreMigrationOptions): ProjectStoreMigrationPlan {
  const plan = planProjectStoreMigration(options);
  if (options.dryRun) return plan;
  for (const move of plan.moves) {
    mkdirSync(move.toPath, { recursive: true });
    // Directory rename within the same workspace volume: artifacts travel
    // byte-identical; only their address changes.
    renameSync(move.fromPath, move.toPath);
  }
  if (plan.moves.length > 0) {
    const journalPath = join(options.workspaceRootPath, JOURNAL_NAME);
    const journal: MigrationJournal = existsSync(journalPath)
      ? (JSON.parse(readFileSync(journalPath, 'utf8')) as MigrationJournal)
      : { version: 1, executedAt: new Date().toISOString(), moves: [] };
    journal.moves.push(...plan.moves);
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  }
  return plan;
}
