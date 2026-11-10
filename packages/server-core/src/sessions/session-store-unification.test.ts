import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  loadSession,
  projectSessionStoreRoot,
  writeSessionJsonl,
  type StoredSession,
} from '@polo-ai/shared/sessions'
import type { StoredMessage } from '@polo-ai/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// POO-205 C5: the session store root unification. A project session's
// EVERYTHING (record, transcripts, plans, data, deletion, dedup) resolves
// through SessionManager's single store-root derivation — never through the
// legacy workspace root. Personal sessions are the untouched counter-example.

describe('session store unification (POO-205 C5)', () => {
  let tmpRoot: string
  let sm: SessionManager
  const PROJECT_ID = 'prj_unify-1'

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-unify-'))
    // loadSessionsFromDisk iterates the runtime workspaces — pin the temp
    // one so the dedup/restore paths actually see the seeded stores.
    sm = new SessionManager({ workspace: buildWorkspace() })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  function makeManaged(sessionId: string, opts: { projectId?: string } = {}) {
    return createManagedSession(
      { id: sessionId, name: `session ${sessionId}`, projectId: opts.projectId, createdAt: Date.now() },
      buildWorkspace(),
    )
  }

  /** Expose the C5 private resolution points for direct assertions. */
  function internals() {
    return sm as unknown as {
      sessionDirFor: (managed: ReturnType<typeof makeManaged>) => string
      storeRootForId: (workspaceRootPath: string, sessionId: string) => string
      deleteSessionStores: (managed: ReturnType<typeof makeManaged>) => void
      loadSessionsFromDisk: () => void
      sessions: Map<string, ReturnType<typeof makeManaged>>
    }
  }

  function seedRecord(storeRoot: string, sessionId: string, name: string, messages: StoredMessage[] = []): void {
    const path = getSessionFilePath(storeRoot, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: storeRoot,
      name,
      sessionStatus: 'todo',
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages,
    } as unknown as StoredSession
    writeSessionJsonl(path, stored)
  }

  it('sessionDirFor puts a project session in its project store and a personal session in the legacy root', () => {
    const projectDir = internals().sessionDirFor(makeManaged('uni-proj', { projectId: PROJECT_ID }))
    expect(projectDir).toBe(join(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'sessions', 'uni-proj'))
    expect(projectDir.startsWith(join(tmpRoot, 'project-sessions'))).toBe(true)

    const personalDir = internals().sessionDirFor(makeManaged('uni-personal'))
    expect(personalDir).toBe(join(tmpRoot, 'sessions', 'uni-personal'))
  })

  it('storeRootForId resolves a persisted project session via probe and falls back to the legacy root otherwise', () => {
    seedRecord(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-probe', 'project copy')
    expect(internals().storeRootForId(tmpRoot, 'uni-probe')).toBe(projectSessionStoreRoot(tmpRoot, PROJECT_ID))

    seedRecord(tmpRoot, 'uni-legacy', 'personal copy')
    expect(internals().storeRootForId(tmpRoot, 'uni-legacy')).toBe(tmpRoot)

    // Nothing anywhere: the legacy root is the (branching pre-check's) fallback.
    expect(internals().storeRootForId(tmpRoot, 'uni-unknown')).toBe(tmpRoot)
  })

  it('deleteSessionStores removes the project store AND the legacy companion directory', () => {
    const managed = makeManaged('uni-delete', { projectId: PROJECT_ID })
    seedRecord(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-delete', 'authoritative')
    // A stale legacy-root companion WITHOUT session.jsonl (runtime artifacts only).
    const legacyDir = join(tmpRoot, 'sessions', 'uni-delete')
    mkdirSync(join(legacyDir, '.pi-sessions'), { recursive: true })
    writeFileSync(join(legacyDir, '.pi-sessions', 'turn-1.jsonl'), '{"t":1}', 'utf-8')

    internals().deleteSessionStores(managed)

    expect(existsSync(join(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'sessions', 'uni-delete'))).toBe(false)
    expect(existsSync(legacyDir)).toBe(false)
  })

  it('deleteSessionStores also removes a stale pre-unification full legacy copy (with its own session.jsonl)', () => {
    const managed = makeManaged('uni-stale', { projectId: PROJECT_ID })
    seedRecord(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-stale', 'authoritative')
    seedRecord(tmpRoot, 'uni-stale', 'STALE pre-unification copy')

    internals().deleteSessionStores(managed)

    // The authoritative project record is gone with the session...
    expect(existsSync(join(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'sessions', 'uni-stale'))).toBe(false)
    // ...and the stale full copy cannot resurrect it.
    expect(existsSync(join(tmpRoot, 'sessions', 'uni-stale'))).toBe(false)
  })

  it('a reload after deleting a project session does not resurrect it (from either store)', () => {
    const managed = makeManaged('uni-no-resurrect', { projectId: PROJECT_ID })
    seedRecord(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-no-resurrect', 'authoritative')
    seedRecord(tmpRoot, 'uni-no-resurrect', 'stale copy')

    internals().deleteSessionStores(managed)
    internals().sessions.clear()
    internals().loadSessionsFromDisk()

    expect(internals().sessions.has('uni-no-resurrect')).toBe(false)
    expect(loadSession(tmpRoot, 'uni-no-resurrect')).toBeNull()
    expect(loadSession(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-no-resurrect')).toBeNull()
  })

  it('loadSessionsFromDisk dedup prefers the project store and warns about the legacy copy', () => {
    seedRecord(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-dedup', 'PROJECT VERSION')
    seedRecord(tmpRoot, 'uni-dedup', 'STALE LEGACY VERSION')
    seedRecord(tmpRoot, 'uni-personal-only', 'personal session')

    internals().loadSessionsFromDisk()

    const deduped = internals().sessions.get('uni-dedup')
    expect(deduped).toBeDefined()
    expect(deduped!.name).toBe('PROJECT VERSION')
    const personal = internals().sessions.get('uni-personal-only')
    expect(personal).toBeDefined()
    expect(personal!.projectId).toBeUndefined()
  })

  it('a project session round-trips: write through the unified dir reads back from the project store, legacy root stays empty', () => {
    // The C5 end-to-end shape at the storage layer: artifacts written under
    // sessionDirFor(managed) must be readable from the project store, and the
    // legacy root must never gain a directory for this session.
    const managed = makeManaged('uni-roundtrip', { projectId: PROJECT_ID })
    const sessionDir = internals().sessionDirFor(managed)
    mkdirSync(join(sessionDir, 'plans'), { recursive: true })
    writeFileSync(join(sessionDir, 'plans', 'plan.md'), '# unified', 'utf-8')
    seedRecord(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-roundtrip', 'record')

    expect(loadSession(projectSessionStoreRoot(tmpRoot, PROJECT_ID), 'uni-roundtrip')?.name).toBe('record')
    expect(readFileSync(join(sessionDir, 'plans', 'plan.md'), 'utf-8')).toBe('# unified')
    expect(existsSync(join(tmpRoot, 'sessions', 'uni-roundtrip'))).toBe(false)
  })
})
