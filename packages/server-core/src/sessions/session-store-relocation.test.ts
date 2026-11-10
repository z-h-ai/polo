import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceSessionStorage } from '@polo-ai/shared/sessions'
import { relocateProjectSessionArtifacts, type RelocationLogger } from './session-store-relocation'

/** Silent logger with capture, so assertions can inspect warnings. */
function captureLogger(): RelocationLogger & { warnings: string[]; infos: string[] } {
  const warnings: string[] = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    info: (message: string) => infos.push(message),
    warn: (message: string) => warnings.push(message),
  }
}

describe('relocateProjectSessionArtifacts (POO-205 C5)', () => {
  let wsRoot: string
  const storage = new WorkspaceSessionStorage()
  let log: ReturnType<typeof captureLogger>

  const PROJECT_ID = 'prj_relocation-1'

  function projectSessionDir(sessionId: string): string {
    return join(wsRoot, 'project-sessions', PROJECT_ID, 'sessions', sessionId)
  }

  function legacySessionDir(sessionId: string): string {
    return join(wsRoot, 'sessions', sessionId)
  }

  /** Seed the authoritative project-store copy (session.jsonl required). */
  function seedProjectSession(sessionId: string, extraFiles: Record<string, string> = {}): void {
    const dir = projectSessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), '{"header":true}\n', 'utf-8')
    for (const [name, content] of Object.entries(extraFiles)) {
      const path = join(dir, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content, 'utf-8')
    }
  }

  /** Seed a stray legacy-root runtime directory WITHOUT session.jsonl. */
  function seedStrayLegacyDir(sessionId: string, files: Record<string, string>): void {
    const dir = legacySessionDir(sessionId)
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content, 'utf-8')
    }
  }

  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'poo205-relocation-'))
    mkdirSync(join(wsRoot, 'sessions'), { recursive: true })
    log = captureLogger()
  })

  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true })
  })

  it('renames stray runtime artifacts of a project session into its project store and empties the legacy dir', () => {
    const sessionId = '261109-stray-move'
    seedProjectSession(sessionId)
    seedStrayLegacyDir(sessionId, {
      '.pi-sessions/turn-1.jsonl': '{"turn":1}',
      '.pi-agent/settings.json': '{}',
      'plans/plan.md': '# plan',
      'audit.jsonl': '{"event":"genui_app_pin"}',
    })

    const summary = relocateProjectSessionArtifacts(wsRoot, storage, log)

    expect(summary.relocated).toBe(1)
    expect(summary.conflicts).toBe(0)
    expect(existsSync(legacySessionDir(sessionId))).toBe(false)
    const projectDir = projectSessionDir(sessionId)
    expect(readFileSync(join(projectDir, '.pi-sessions', 'turn-1.jsonl'), 'utf-8')).toBe('{"turn":1}')
    expect(readFileSync(join(projectDir, '.pi-agent', 'settings.json'), 'utf-8')).toBe('{}')
    expect(readFileSync(join(projectDir, 'plans', 'plan.md'), 'utf-8')).toBe('# plan')
    expect(readFileSync(join(projectDir, 'audit.jsonl'), 'utf-8')).toBe('{"event":"genui_app_pin"}')
    // The authoritative record was never touched.
    expect(readFileSync(join(projectDir, 'session.jsonl'), 'utf-8')).toBe('{"header":true}\n')
    // Journal: written before the rename, stamped finished after.
    const journal = JSON.parse(readFileSync(join(wsRoot, '.migrations', 'session-store-relocation', `${sessionId}.json`), 'utf-8'))
    expect(journal).toMatchObject({ sessionId, projectId: PROJECT_ID, from: legacySessionDir(sessionId), to: projectDir })
    expect(typeof journal.startedAt).toBe('string')
    expect(typeof journal.finishedAt).toBe('string')
  })

  it('keeps conflicting files in the legacy root and never overwrites the project-store copy', () => {
    const sessionId = '261109-stray-conflict'
    seedProjectSession(sessionId, {
      '.pi-agent/settings.json': '{"authoritative":true}',
      'plans/plan.md': '# project copy',
    })
    seedStrayLegacyDir(sessionId, {
      '.pi-agent/settings.json': '{"stray":true}',
      'plans/plan.md': '# stray copy',
      'data/tool-result.txt': 'stray data',
    })

    const summary = relocateProjectSessionArtifacts(wsRoot, storage, log)

    expect(summary.relocated).toBe(1)
    expect(summary.conflicts).toBe(2)
    // Project-store copies win, byte for byte.
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-agent', 'settings.json'), 'utf-8')).toBe('{"authoritative":true}')
    expect(readFileSync(join(projectSessionDir(sessionId), 'plans', 'plan.md'), 'utf-8')).toBe('# project copy')
    // Non-conflicting entries still moved.
    expect(readFileSync(join(projectSessionDir(sessionId), 'data', 'tool-result.txt'), 'utf-8')).toBe('stray data')
    // Conflict residue keeps the legacy dir (and warns for a human).
    expect(existsSync(join(legacySessionDir(sessionId), '.pi-agent', 'settings.json'))).toBe(true)
    expect(readFileSync(join(legacySessionDir(sessionId), '.pi-agent', 'settings.json'), 'utf-8')).toBe('{"stray":true}')
    expect(log.warnings.some(w => w.includes('Relocation conflict'))).toBe(true)
    // No finished stamp while conflicts remain — the next run re-tries.
    const journal = JSON.parse(readFileSync(join(wsRoot, '.migrations', 'session-store-relocation', `${sessionId}.json`), 'utf-8'))
    expect(journal.finishedAt).toBeUndefined()
  })

  it('is idempotent: the second run is a no-op (the drained directory is simply gone)', () => {
    const sessionId = '261109-stray-idem'
    seedProjectSession(sessionId)
    seedStrayLegacyDir(sessionId, { '.pi-sessions/turn-1.jsonl': '{"t":1}' })

    const first = relocateProjectSessionArtifacts(wsRoot, storage, log)
    expect(first.relocated).toBe(1)
    expect(existsSync(legacySessionDir(sessionId))).toBe(false)

    const second = relocateProjectSessionArtifacts(wsRoot, storage, log)
    expect(second.relocated).toBe(0)
    expect(second.alreadyFinished).toBe(0)
    expect(second.conflicts).toBe(0)
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-sessions', 'turn-1.jsonl'), 'utf-8')).toBe('{"t":1}')
  })

  it('skips a finished relocation even when a NEW legacy-root residue appears afterwards', () => {
    const sessionId = '261109-stray-residue'
    seedProjectSession(sessionId)
    seedStrayLegacyDir(sessionId, { '.pi-sessions/turn-1.jsonl': '{"t":1}' })
    relocateProjectSessionArtifacts(wsRoot, storage, log)

    // A live writer recreates stray artifacts AFTER the finished relocation —
    // the finished journal means the unified paths own it now; we must not
    // resurrect a relocation loop underneath a running session.
    seedStrayLegacyDir(sessionId, { '.pi-sessions/turn-2.jsonl': '{"t":2}' })
    mkdirSync(join(wsRoot, '.migrations', 'session-store-relocation'), { recursive: true })
    const journalPath = join(wsRoot, '.migrations', 'session-store-relocation', `${sessionId}.json`)
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
    expect(typeof journal.finishedAt).toBe('string')

    const summary = relocateProjectSessionArtifacts(wsRoot, storage, log)
    expect(summary.relocated).toBe(0)
    expect(summary.alreadyFinished).toBe(1)
    // The new residue stays untouched for the live session to keep writing.
    expect(existsSync(join(legacySessionDir(sessionId), '.pi-sessions', 'turn-2.jsonl'))).toBe(true)
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-sessions', 'turn-1.jsonl'), 'utf-8')).toBe('{"t":1}')
  })

  it('resumes after a simulated crash: a journal without finishedAt does not block the merge', () => {
    const sessionId = '261109-stray-crash'
    seedProjectSession(sessionId)
    seedStrayLegacyDir(sessionId, {
      '.pi-sessions/turn-1.jsonl': '{"t":1}',
      '.pi-sessions/turn-2.jsonl': '{"t":2}',
    })
    // Simulate a crashed earlier run: journal exists, first entry already
    // moved, no finishedAt.
    mkdirSync(join(projectSessionDir(sessionId), '.pi-sessions'), { recursive: true })
    renameLikeMove(join(legacySessionDir(sessionId), '.pi-sessions', 'turn-1.jsonl'), join(projectSessionDir(sessionId), '.pi-sessions', 'turn-1.jsonl'))
    mkdirSync(join(wsRoot, '.migrations', 'session-store-relocation'), { recursive: true })
    writeFileSync(join(wsRoot, '.migrations', 'session-store-relocation', `${sessionId}.json`), JSON.stringify({
      sessionId,
      projectId: PROJECT_ID,
      from: legacySessionDir(sessionId),
      to: projectSessionDir(sessionId),
      startedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2))

    const summary = relocateProjectSessionArtifacts(wsRoot, storage, log)

    expect(summary.relocated).toBe(1)
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-sessions', 'turn-1.jsonl'), 'utf-8')).toBe('{"t":1}')
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-sessions', 'turn-2.jsonl'), 'utf-8')).toBe('{"t":2}')
    expect(existsSync(legacySessionDir(sessionId))).toBe(false)
  })

  it('never touches personal sessions, stale full copies, or orphans in the legacy root', () => {
    // Personal session: lives (correctly) in the legacy root WITH its record.
    mkdirSync(legacySessionDir('261109-personal'), { recursive: true })
    writeFileSync(join(legacySessionDir('261109-personal'), 'session.jsonl'), '{"personal":true}\n', 'utf-8')
    // Stale full copy: record in BOTH stores — deletion path owns it.
    seedProjectSession('261109-stale-copy')
    mkdirSync(legacySessionDir('261109-stale-copy'), { recursive: true })
    writeFileSync(join(legacySessionDir('261109-stale-copy'), 'session.jsonl'), '{"stale":true}\n', 'utf-8')
    // Orphan: stray dir with no project record anywhere.
    seedStrayLegacyDir('261109-orphan', { '.pi-sessions/x.jsonl': '{}' })

    const summary = relocateProjectSessionArtifacts(wsRoot, storage, log)

    expect(summary.relocated).toBe(0)
    expect(summary.alreadyFinished).toBe(0)
    expect(readFileSync(join(legacySessionDir('261109-personal'), 'session.jsonl'), 'utf-8')).toBe('{"personal":true}\n')
    expect(readFileSync(join(legacySessionDir('261109-stale-copy'), 'session.jsonl'), 'utf-8')).toBe('{"stale":true}\n')
    expect(readFileSync(join(legacySessionDir('261109-orphan'), '.pi-sessions', 'x.jsonl'), 'utf-8')).toBe('{}')
  })

  it('merges same-named subdirectories entry-by-entry instead of refusing the whole tree', () => {
    const sessionId = '261109-stray-subtree'
    seedProjectSession(sessionId, { '.pi-sessions/turn-1.jsonl': '{"t":1}' })
    seedStrayLegacyDir(sessionId, {
      '.pi-sessions/turn-1.jsonl': '{"t":1-duplicate}',
      '.pi-sessions/turn-2.jsonl': '{"t":2}',
    })

    const summary = relocateProjectSessionArtifacts(wsRoot, storage, log)

    expect(summary.relocated).toBe(1)
    expect(summary.conflicts).toBe(1)
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-sessions', 'turn-1.jsonl'), 'utf-8')).toBe('{"t":1}')
    expect(readFileSync(join(projectSessionDir(sessionId), '.pi-sessions', 'turn-2.jsonl'), 'utf-8')).toBe('{"t":2}')
    // The drained subtree source is gone; only the conflicting file keeps
    // the legacy root alive.
    expect(readdirSync(join(legacySessionDir(sessionId), '.pi-sessions')).sort()).toEqual(['turn-1.jsonl'])
  })
})

/** rename without following symlinks — mirrors what the relocation does. */
function renameLikeMove(from: string, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true })
  const { renameSync } = require('node:fs') as typeof import('node:fs')
  renameSync(from, to)
}
