/**
 * POO-205 C5: one-time, idempotent relocation of pre-unification session
 * artifacts.
 *
 * Between the sessions' introduction and bf5344d3 the agent/SessionManager
 * layers still composed runtime artifact paths from the LEGACY workspace
 * root (`{ws}/sessions/{id}/.pi-sessions`, `.pi-agent`, `plans`, `data`,
 * `long_responses`, …) even for project sessions whose authoritative
 * `session.jsonl` already lived in the project store
 * (`{ws}/project-sessions/{projectId}/sessions/{id}/`). The unification
 * (C5) stopped the bleeding — new artifacts land in the project store — but
 * the strayed artifacts of already-existing sessions stayed behind. This
 * module moves them home, once per workspace at startup:
 *
 * - A legacy-root directory qualifies only when the SAME session id exists
 *   in a project store (its `session.jsonl` is the authoritative record)
 *   AND the legacy directory has NO `session.jsonl` of its own. Everything
 *   else is untouched: personal sessions (their home IS the legacy root),
 *   stale pre-bf5344d3 full copies (handled by the deletion path with an
 *   info log), and unknown orphans stay where they are.
 * - Entries merge into the project-store directory entry-by-entry: a
 *   missing target is renamed over, an existing DIRECTORY target is merged
 *   recursively the same way, and a conflicting FILE is kept where it is
 *   with a warning — never overwritten. Symlinked entries are never moved.
 * - The legacy directory is removed only once it is completely empty; any
 *   conflict residue keeps it (and the warning) alive for a human.
 * - A per-session journal is written under `{ws}/.migrations/
 *   session-store-relocation/` BEFORE the first rename and stamped with
 *   `finishedAt` afterwards, so a crash between renames resumes cleanly on
 *   the next run (the merges themselves are idempotent) and a finished
 *   relocation is skipped without touching disk.
 *
 * P1-6 (migrating pre-project-store ENTERPRISE sessions that have no
 * project record at all) is explicitly out of scope here.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { projectSessionStoreRoot, listProjectSessionStoreRoots } from '@polo-ai/shared/sessions'

/** The path surfaces the relocation needs from the runtime storage. */
export type RelocationStorage = Pick<
  import('@polo-ai/shared/sessions').SessionStorage,
  'getSessionsRoot' | 'getSessionPath'
>

export interface RelocationLogger {
  info: (message: string, ...details: unknown[]) => void
  warn: (message: string, ...details: unknown[]) => void
}

export interface RelocationSummary {
  /** Sessions whose strayed artifacts were merged into their project store. */
  relocated: number
  /** Conflicting files kept in the legacy root (never overwritten). */
  conflicts: number
  /** Qualifying sessions whose journal already says finished — skipped. */
  alreadyFinished: number
}

interface RelocationJournal {
  sessionId: string
  projectId: string
  from: string
  to: string
  startedAt: string
  finishedAt?: string
}

const RELOCATION_DIRNAME = 'session-store-relocation'

function migrationDirFor(workspaceRootPath: string): string {
  return join(workspaceRootPath, '.migrations', RELOCATION_DIRNAME)
}

function journalPathFor(workspaceRootPath: string, sessionId: string): string {
  return join(migrationDirFor(workspaceRootPath), `${sessionId}.json`)
}

function readJournal(path: string): RelocationJournal | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RelocationJournal>
    if (typeof parsed.sessionId !== 'string' || typeof parsed.to !== 'string') return null
    return parsed as RelocationJournal
  } catch {
    return null
  }
}

/**
 * The project store holding the authoritative copy of a session id, derived
 * by exact-path probe over every project store root.
 */
function findProjectStoreRootFor(
  workspaceRootPath: string,
  sessionId: string,
  storage: RelocationStorage,
): string | null {
  for (const projectRoot of listProjectSessionStoreRoots(workspaceRootPath)) {
    if (existsSync(storage.getSessionPath(projectRoot, sessionId))) {
      // The session DIRECTORY alone would not prove authorship — require the
      // record file, which is exactly what loadSessionsFromDisk lists from.
      const recordPath = join(storage.getSessionPath(projectRoot, sessionId), 'session.jsonl')
      if (existsSync(recordPath)) return projectRoot
    }
  }
  return null
}

type MergeResult = { moved: number; conflicts: number }

/**
 * Move every entry of `fromDir` into `toDir`: rename when the target is
 * free, recurse into same-named directories, keep conflicting files in
 * place with a warning. Symlinks are never moved (they are not session
 * artifacts we produced). Returns what happened so the caller can warn.
 */
function mergeDirectoryTree(
  fromDir: string,
  toDir: string,
  log: RelocationLogger,
): MergeResult {
  let moved = 0
  let conflicts = 0
  mkdirSync(toDir, { recursive: true })
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      log.warn(`Relocation kept a symlinked entry in place: ${join(fromDir, entry.name)}`)
      conflicts += 1
      continue
    }
    const sourcePath = join(fromDir, entry.name)
    const targetPath = join(toDir, entry.name)
    if (!existsSync(targetPath)) {
      try {
        renameSync(sourcePath, targetPath)
        moved += 1
        continue
      } catch (error) {
        log.warn(`Relocation failed to move ${sourcePath} → ${targetPath}; keeping the original`, error)
        conflicts += 1
        continue
      }
    }
    let targetIsDir = false
    try {
      targetIsDir = lstatSync(targetPath).isDirectory()
    } catch {
      targetIsDir = false
    }
    if (entry.isDirectory() && targetIsDir) {
      const nested = mergeDirectoryTree(sourcePath, targetPath, log)
      moved += nested.moved
      conflicts += nested.conflicts
      // The subtree is drained — drop the now-empty source directory so the
      // session's legacy root can become removable.
      try {
        if (readdirSync(sourcePath).length === 0) rmdirSync(sourcePath)
      } catch {
        // Non-empty or unreadable: the parent-level emptiness check keeps it.
      }
      continue
    }
    log.warn(
      `Relocation conflict: both ${sourcePath} and ${targetPath} exist — the legacy-root copy is KEPT UNTOUCHED, the project-store copy wins`,
    )
    conflicts += 1
  }
  return { moved, conflicts }
}

function legacyDirectoryIsEmpty(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/**
 * Relocate every qualifying legacy-root session directory of the workspace
 * into its project store. Safe to call repeatedly: finished journals skip,
 * drained directories no longer exist, and merges are idempotent.
 */
export function relocateProjectSessionArtifacts(
  workspaceRootPath: string,
  storage: RelocationStorage,
  log: RelocationLogger,
): RelocationSummary {
  const summary: RelocationSummary = { relocated: 0, conflicts: 0, alreadyFinished: 0 }
  const legacyRoot = storage.getSessionsRoot(workspaceRootPath)
  if (!existsSync(legacyRoot)) return summary

  let candidateDirs: string[]
  try {
    candidateDirs = readdirSync(legacyRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => entry.name)
  } catch {
    return summary
  }

  for (const sessionId of candidateDirs) {
    const legacyDir = join(legacyRoot, sessionId)
    // A full legacy copy (session.jsonl present) is a stale pre-bf5344d3
    // duplicate or a personal session — both are owned by other paths.
    if (existsSync(join(legacyDir, 'session.jsonl'))) continue

    const journalPath = journalPathFor(workspaceRootPath, sessionId)
    const existingJournal = readJournal(journalPath)
    if (existingJournal?.finishedAt) {
      // Finished in a previous run: the legacy directory should already be
      // gone; if a NEW residue appeared it belongs to a live writer, not us.
      summary.alreadyFinished += 1
      continue
    }

    const projectRoot = findProjectStoreRootFor(workspaceRootPath, sessionId, storage)
    if (!projectRoot) continue

    const projectId = basename(projectRoot)
    const projectDir = storage.getSessionPath(projectRoot, sessionId)

    // Journal BEFORE the first rename: a crash mid-relocation leaves a
    // journal without finishedAt, and the next run resumes the merge.
    try {
      mkdirSync(migrationDirFor(workspaceRootPath), { recursive: true })
      const journal: RelocationJournal = existingJournal ?? {
        sessionId,
        projectId,
        from: legacyDir,
        to: projectDir,
        startedAt: new Date().toISOString(),
      }
      writeFileSync(journalPath, JSON.stringify({ ...journal, finishedAt: undefined }, null, 2))
    } catch (error) {
      log.warn(`Relocation could not write the journal for ${sessionId}; skipping this session this run`, error)
      continue
    }

    let result: MergeResult = { moved: 0, conflicts: 0 }
    try {
      result = mergeDirectoryTree(legacyDir, projectDir, log)
    } catch (error) {
      log.warn(`Relocation of ${sessionId} failed mid-merge; it will resume on the next run`, error)
      summary.conflicts += result.conflicts
      continue
    }
    summary.relocated += 1
    summary.conflicts += result.conflicts

    if (legacyDirectoryIsEmpty(legacyDir)) {
      try {
        // POSIX rmdir: fails ENOTEMPTY on residue, exactly the guard we want.
        rmdirSync(legacyDir)
      } catch (error) {
        log.warn(`Relocation could not remove the emptied legacy directory ${legacyDir}`, error)
      }
    } else {
      log.warn(
        `Legacy-root directory for project session ${sessionId} kept conflict residue — relocated ${result.moved} entries, ${result.conflicts} conflicts remain for manual inspection: ${legacyDir}`,
      )
    }

    if (result.conflicts === 0) {
      // Only stamp finished when nothing was left behind — a conflicted
      // relocation must re-run (and re-warn) until resolved.
      try {
        writeFileSync(journalPath, JSON.stringify({
          ...readJournal(journalPath),
          sessionId,
          projectId,
          from: legacyDir,
          to: projectDir,
          finishedAt: new Date().toISOString(),
        }, null, 2))
      } catch (error) {
        log.warn(`Relocation could not stamp the journal finished for ${sessionId}; it will redo the (idempotent) merge next run`, error)
      }
    }
  }
  return summary
}
