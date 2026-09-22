import { describe, expect, it } from 'bun:test'
import {
  canUninstallManagedSkill,
  decodeSkillSceneBits,
  discoverRowState,
  localSkillRowState,
  managedSkillFromLoaded,
  type ManagedSkill,
} from '../types'
import type { LoadedSkill } from '../../../../../shared/types'

function loadedSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    slug: 'sales-weekly',
    metadata: { name: '销售周报', description: '按团队格式汇总本周进展、风险和下周计划。' },
    content: '',
    path: '/workspace/skills/sales-weekly',
    source: 'workspace',
    ...overrides,
  }
}

const installedCreatorSkill = (overrides: Partial<NonNullable<LoadedSkill['creatorInstallation']>> = {}) =>
  loadedSkill({
    creatorInstallation: {
      artifactId: 'artifact-1',
      organizationId: 'org-1',
      slug: 'sales-weekly',
      version: '1.0.0',
      archiveChecksum: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      installedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    },
  })

describe('decodeSkillSceneBits', () => {
  it('decodes the sampled scene suffixes', () => {
    expect(decodeSkillSceneBits('100-0-0')).toEqual({
      version: '1.0.0',
      enabled: false,
      builtin: false,
    })
    expect(decodeSkillSceneBits('100-1-0')).toEqual({
      version: '1.0.0',
      enabled: true,
      builtin: false,
    })
    expect(decodeSkillSceneBits('110-0-1')).toEqual({
      version: '1.1.0',
      enabled: false,
      builtin: true,
    })
  })

  it('decodes the 110-1-1 boundary combination', () => {
    expect(decodeSkillSceneBits('110-1-1')).toEqual({
      version: '1.1.0',
      enabled: true,
      builtin: true,
    })
  })

  it('decodes the not-installed and revoked sentinels', () => {
    expect(decodeSkillSceneBits('none')).toEqual({
      version: 'none',
      enabled: false,
      builtin: true,
    })
    expect(decodeSkillSceneBits('revoked')).toEqual({
      version: 'revoked',
      enabled: false,
      builtin: true,
    })
  })

  it('rejects malformed suffixes', () => {
    expect(() => decodeSkillSceneBits('100-0')).toThrow()
    expect(() => decodeSkillSceneBits('abcd-0-0')).toThrow()
  })

  it("derives the built-in row's on/off state from the THIRD bit (the second bit belongs to the distributed row)", () => {
    // Demo mapping (registry builtinSkill): `enabled: bits.builtin`.
    // P-M06-SKILLS default '100-0-1' renders enabled; P-M06-BUILTIN-OFF-ENT
    // '100-0-0' renders disabled — regardless of the second bit.
    expect(decodeSkillSceneBits('100-0-1').builtin).toBe(true)
    expect(decodeSkillSceneBits('100-1-1').builtin).toBe(true)
    expect(decodeSkillSceneBits('100-0-0').builtin).toBe(false)
    expect(decodeSkillSceneBits('100-1-0').builtin).toBe(false)
  })
})

describe('localSkillRowState (state-bit combinations)', () => {
  const row = (overrides: Partial<Parameters<typeof localSkillRowState>[0]>) =>
    localSkillRowState({
      slug: 'x',
      name: 'x',
      description: '',
      origin: 'circle',
      originLabel: '',
      enabled: false,
      restricted: false,
      ...overrides,
    })

  it('covers the sampled scene combinations', () => {
    // 100-0-0: installed, disabled
    expect(row({ installedVersion: '1.0.0', enabled: false })).toBe('disabled')
    // 100-1-0: installed, enabled
    expect(row({ installedVersion: '1.0.0', enabled: true })).toBe('enabled')
    // 110-0-0: 1.1.0 installed, disabled, no newer version
    expect(row({ installedVersion: '1.1.0', enabled: false })).toBe('disabled')
    // 110-1-0: 1.1.0 installed, enabled
    expect(row({ installedVersion: '1.1.0', enabled: true })).toBe('enabled')
    // update available beats the enabled bit
    expect(row({
      installedVersion: '1.0.0',
      availableVersion: '1.1.0',
      enabled: true,
    })).toBe('update-available')
    // restricted beats everything (copy kept, disabled)
    expect(row({
      installedVersion: '1.0.0',
      availableVersion: '1.1.0',
      enabled: true,
      restricted: true,
    })).toBe('restricted')
  })

  it('treats an unchanged available version as no update', () => {
    expect(row({
      installedVersion: '1.1.0',
      availableVersion: '1.1.0',
      enabled: false,
    })).toBe('disabled')
  })
})

describe('discoverRowState', () => {
  it('maps not-installed, update and restricted entries', () => {
    const base = {
      slug: 'growth-cases',
      name: '增长案例检索',
      description: '',
      provider: '晨星增长工作室',
      version: '1.0.0',
    }
    expect(discoverRowState(base)).toBe('installable')
    expect(discoverRowState({
      ...base,
      installed: { version: '1.0.0', enabled: false, restricted: false },
    })).toBe('installed')
    expect(discoverRowState({
      ...base,
      installed: { version: '1.0.0', enabled: true, restricted: false, updateVersion: '1.1.0' },
    })).toBe('update-available')
    expect(discoverRowState({
      ...base,
      installed: { version: '1.0.0', enabled: false, restricted: true },
    })).toBe('restricted')
  })
})

describe('managedSkillFromLoaded (R6 lifecycle rules)', () => {
  it('R6-3: a distributed install defaults to disabled — installing never auto-enables', () => {
    const managed = managedSkillFromLoaded(installedCreatorSkill())
    expect(managed.origin).toBe('org')
    expect(managed.enabled).toBe(false)
    expect(managed.installedVersion).toBe('1.0.0')
  })

  it('built-in (global) skills default to enabled', () => {
    const managed = managedSkillFromLoaded(loadedSkill({ source: 'global' }))
    expect(managed.origin).toBe('builtin')
    expect(managed.enabled).toBe(true)
  })

  it('real local skills (workspace / project) default to enabled', () => {
    // Local copies were already active before the manager existed.
    expect(managedSkillFromLoaded(loadedSkill({ source: 'workspace' })).enabled).toBe(true)
    expect(managedSkillFromLoaded(loadedSkill({ source: 'project' })).enabled).toBe(true)
  })

  it('R6-7: a revoked source keeps the copy, forces disabled and marks it restricted', () => {
    const managed = managedSkillFromLoaded(installedCreatorSkill({
      lastKnownStatus: 'revoked',
    }))
    expect(managed.restricted).toBe(true)
    expect(managed.enabled).toBe(false)
    expect(managed.installedVersion).toBe('1.0.0')
    expect(managed.skill).toBeDefined()
  })

  it('an archived source is restricted as well', () => {
    expect(managedSkillFromLoaded(installedCreatorSkill({
      lastKnownStatus: 'archived',
    })).restricted).toBe(true)
  })
})

describe('canUninstallManagedSkill (uninstall channel gating)', () => {
  const row = (overrides: Partial<ManagedSkill> = {}): ManagedSkill => ({
    slug: 'x',
    name: 'x',
    description: '',
    origin: 'personal',
    originLabel: '',
    enabled: true,
    restricted: false,
    ...overrides,
  })

  it('allows workspace-local copies (where creator-installed skills land)', () => {
    expect(canUninstallManagedSkill(row({
      skill: loadedSkill({ source: 'workspace' }),
    }))).toBe(true)
  })

  it('rejects rows without a real channel: demo rows, builtin/global, project-managed', () => {
    expect(canUninstallManagedSkill(row())).toBe(false)
    expect(canUninstallManagedSkill(row({
      origin: 'builtin',
      skill: loadedSkill({ source: 'global' }),
    }))).toBe(false)
    expect(canUninstallManagedSkill(row({
      skill: loadedSkill({ source: 'project' }),
    }))).toBe(false)
  })
})
