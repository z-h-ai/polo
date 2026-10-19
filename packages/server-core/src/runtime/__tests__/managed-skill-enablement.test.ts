import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  managedSkillEnablementFilePath,
  readDisabledManagedSkillSlugs,
  readManagedSkillEnablementDocument,
  setManagedSkillsRoot,
  writeManagedSkillEnablement,
} from '../managed-skill-enablement'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab'
const WORKSPACE_A = '/tmp/ws-a'
const WORKSPACE_B = '/tmp/ws-b'

let storageRoot: string

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'managed-skills-'))
  setManagedSkillsRoot(storageRoot)
})

afterEach(() => {
  setManagedSkillsRoot(null)
  rmSync(storageRoot, { recursive: true, force: true })
})

describe('managed skill enablement store', () => {
  it('resolves one document per account × workspace scope', () => {
    const sameScope = managedSkillEnablementFilePath(ACCOUNT, WORKSPACE_A)
    expect(sameScope).toBe(managedSkillEnablementFilePath(ACCOUNT, `${WORKSPACE_A}/`))
    expect(sameScope).not.toBe(managedSkillEnablementFilePath(ACCOUNT, WORKSPACE_B))
    expect(sameScope).not.toBe(managedSkillEnablementFilePath(OTHER_ACCOUNT, WORKSPACE_A))
    expect(sameScope.startsWith(storageRoot)).toBe(true)
  })

  it('reads an empty document before the first write', () => {
    const document = readManagedSkillEnablementDocument(ACCOUNT, WORKSPACE_A)
    expect(document.revision).toBe(0)
    expect(document.entries).toEqual({})
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_A)).toEqual(new Set())
  })

  it('persists a disabled slug and bumps the revision', () => {
    const result = writeManagedSkillEnablement({
      accountId: ACCOUNT,
      workspaceRoot: WORKSPACE_A,
      slug: 'review-skill',
      source: 'workspace',
      enabled: false,
    })
    expect(result).toEqual({ ok: true, revision: 1 })
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_A)).toEqual(new Set(['review-skill']))
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_B)).toEqual(new Set())
    expect(readDisabledManagedSkillSlugs(OTHER_ACCOUNT, WORKSPACE_A)).toEqual(new Set())
  })

  it('drops the entry when a skill is re-enabled, keeping the revision monotonic', () => {
    writeManagedSkillEnablement({ accountId: ACCOUNT, workspaceRoot: WORKSPACE_A, slug: 'review-skill', source: 'workspace', enabled: false })
    const second = writeManagedSkillEnablement({ accountId: ACCOUNT, workspaceRoot: WORKSPACE_A, slug: 'review-skill', source: 'workspace', enabled: true })
    expect(second).toEqual({ ok: true, revision: 2 })
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_A)).toEqual(new Set())
    expect(readManagedSkillEnablementDocument(ACCOUNT, WORKSPACE_A).revision).toBe(2)
  })

  it('rejects a stale expectedRevision without mutating the document', () => {
    const first = writeManagedSkillEnablement({ accountId: ACCOUNT, workspaceRoot: WORKSPACE_A, slug: 'a', source: 'global', enabled: false })
    const conflict = writeManagedSkillEnablement({
      accountId: ACCOUNT,
      workspaceRoot: WORKSPACE_A,
      slug: 'b',
      source: 'global',
      enabled: false,
      expectedRevision: 99,
    })
    expect(conflict).toEqual({ ok: false, errorCode: 'revision_conflict', revision: first.ok ? first.revision : 0 })
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_A)).toEqual(new Set(['a']))
  })

  it('accepts a write when the echoed revision still matches', () => {
    const first = writeManagedSkillEnablement({ accountId: ACCOUNT, workspaceRoot: WORKSPACE_A, slug: 'a', source: 'global', enabled: false })
    if (!first.ok) throw new Error('expected first write to succeed')
    const second = writeManagedSkillEnablement({
      accountId: ACCOUNT,
      workspaceRoot: WORKSPACE_A,
      slug: 'b',
      source: 'project',
      enabled: false,
      expectedRevision: first.revision,
    })
    expect(second).toEqual({ ok: true, revision: first.revision + 1 })
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_A)).toEqual(new Set(['a', 'b']))
  })

  it('falls back to the empty document for unreadable files', () => {
    const filePath = managedSkillEnablementFilePath(ACCOUNT, WORKSPACE_A)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, '{ not json', { mode: 0o600 })
    expect(readManagedSkillEnablementDocument(ACCOUNT, WORKSPACE_A).revision).toBe(0)
    expect(readDisabledManagedSkillSlugs(ACCOUNT, WORKSPACE_A)).toEqual(new Set())
  })
})
