import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer, RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
} from '../../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../trusted-product-space-account'
import { bindCanonicalSkillContextResolver } from '../../../runtime/canonical-skills'
import { setManagedSkillsRoot, writeManagedSkillEnablement } from '../../../runtime/managed-skill-enablement'
import { setBundledAssetsRoot, clearBundledAssetsRoot, getBundledAssetsRoot } from '@polo-ai/shared/utils/paths'
import { BUNDLED_SKILLS_ASSET_DIRNAME, invalidateSkillsCache } from '@polo-ai/shared/skills'
import { registerSkillsHandlers } from '../skills'

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'ws-one'

function writeSkill(skillsRoot: string, slug: string, name: string): void {
  const dir = join(skillsRoot, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody.\n`)
}

let tempDir: string
let workspaceRoot: string
let managedSkillsRoot: string
let savedAssetsRoot: string | undefined

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return null },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager: {
      getWorkspaces: () => [{ id: WORKSPACE_ID, rootPath: workspaceRoot, name: 'Workspace One' }],
    },
    // Exercise the HandlerDeps injection seam instead of the CONFIG_DIR
    // fallback so the handlers never touch the developer's real store.
    managedSkillsRoot: managedSkillsRoot,
    platform: { logger: { info: () => {}, error: () => {} } },
  } as unknown as HandlerDeps
  registerSkillsHandlers(server, deps)
  const ctx = { clientId: 'client-1', workspaceId: WORKSPACE_ID, webContentsId: 1 } as unknown as RequestContext
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler for ${channel}`)
    return handler(ctx, ...args)
  }
  return { invoke }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-managed-rpc-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true })
  savedAssetsRoot = getBundledAssetsRoot()
  setBundledAssetsRoot(join(tempDir, 'electron'))
  const bundledRoot = join(tempDir, 'electron', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME)
  mkdirSync(bundledRoot, { recursive: true })
  writeSkill(bundledRoot, 'bundled-helper', 'Bundled Helper')
  writeSkill(bundledRoot, 'bundled-only', 'Bundled Only')
  // A plain workspace skill, plus one whose slug shadows the bundled tier.
  writeSkill(join(workspaceRoot, 'skills'), 'review-skill', 'Review Skill')
  writeSkill(join(workspaceRoot, 'skills'), 'bundled-helper', 'Shadowing Review Skill')
  managedSkillsRoot = join(tempDir, 'managed-skills')
  setManagedSkillsRoot(managedSkillsRoot)
  setRuntimeActiveProductSpace('ps-one')
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  bindCanonicalSkillContextResolver(async () => ({
    id: 'ps-one', kind: 'personal', accessMode: 'active',
  } as never))
  invalidateSkillsCache()
})

afterEach(() => {
  bindCanonicalSkillContextResolver(async () => { throw new Error('Skill ProductSpace authority unavailable') })
  setManagedSkillsRoot(null)
  clearBundledAssetsRoot()
  if (savedAssetsRoot) setBundledAssetsRoot(savedAssetsRoot)
  setRuntimeActiveProductSpace(null)
  setTrustedProductSpaceAccountProvider(async () => null)
  setSyncTrustedProductSpaceAccountId(null)
  invalidateSkillsCache()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('skills.listManaged', () => {
  it('flags bundled, toggleable and shadowedBuiltin rows', async () => {
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: WORKSPACE_ID })
    expect(response.ok).toBe(true)
    const bySlug = Object.fromEntries(response.items.map((item: { slug: string }) => [item.slug, item]))
    expect(bySlug['bundled-helper']).toMatchObject({
      source: 'workspace', enabled: true, toggleable: false, managed: false, shadowedBuiltin: true,
    })
    expect(bySlug['review-skill']).toMatchObject({
      source: 'workspace', enabled: true, toggleable: true, managed: false, shadowedBuiltin: false,
    })
    const bundledRow = response.items.find((item: { slug: string; source: string }) => item.slug === 'bundled-helper' && item.source === 'bundled')
    expect(bundledRow).toBeUndefined()
  })

  it('marks a legacy creator installation as managed and non-toggleable (SM-18g)', async () => {
    writeFileSync(join(workspaceRoot, 'creator-skills.json'), JSON.stringify({
      schemaVersion: 1,
      installed: [{
        artifactId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        slug: 'review-skill',
        version: '1.0.0',
        archiveChecksum: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    invalidateSkillsCache()
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: WORKSPACE_ID })
    const row = response.items.find((item: { slug: string }) => item.slug === 'review-skill')
    expect(row).toMatchObject({ managed: true, toggleable: false, enabled: true })
  })

  it('reports the persisted disabled state and revision', async () => {
    writeManagedSkillEnablement({ accountId: ACCOUNT_ID, workspaceRoot, slug: 'review-skill', source: 'workspace', enabled: false })
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: WORKSPACE_ID })
    const row = response.items.find((item: { slug: string }) => item.slug === 'review-skill')
    expect(row).toMatchObject({ enabled: false, toggleable: true })
    expect(response.revision).toBe(1)
  })

  it('returns an empty inventory for an unknown or remote workspace', async () => {
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: 'ws-unknown' })
    expect(response).toEqual({ ok: true, workspaceId: 'ws-unknown', revision: 0, items: [] })
  })

  it('returns an empty inventory in the offline read-only view', async () => {
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: WORKSPACE_ID })
    expect(response.items).toEqual([])
  })

  it('rejects a malformed request', async () => {
    const { invoke } = createHarness()
    expect(await invoke(RPC_CHANNELS.skills.LIST_MANAGED, {})).toEqual({ ok: false, errorCode: 'VALIDATION_ERROR' })
  })
})

describe('skills.setManagedEnablement', () => {
  it('writes a disable request, bumps the revision and reports it', async () => {
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'review-skill', source: 'workspace', enabled: false,
    })
    expect(response).toEqual({ ok: true, slug: 'review-skill', enabled: false, revision: 1 })
    const list = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: WORKSPACE_ID })
    expect(list.items.find((item: { slug: string }) => item.slug === 'review-skill').enabled).toBe(false)
  })

  it('refuses bundled slugs even when disguised as a user tier (SM-18d)', async () => {
    const { invoke } = createHarness()
    await expect(SetSourceBundled(invoke)).resolves.toEqual({ ok: false, errorCode: 'VALIDATION_ERROR' })
    const disguised = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'bundled-only', source: 'workspace', enabled: false,
    })
    expect(disguised).toEqual({ ok: false, errorCode: 'bundled_skill_not_disableable' })
  })

  it('refuses shadowedBuiltin rows through the batch side door (K8)', async () => {
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'bundled-helper', source: 'workspace', enabled: false,
    })
    expect(response).toEqual({ ok: false, errorCode: 'shadowed_builtin_not_toggleable' })
  })

  it('refuses managed (creator-installed) rows (SM-18g)', async () => {
    writeFileSync(join(workspaceRoot, 'creator-skills.json'), JSON.stringify({
      schemaVersion: 1,
      installed: [{
        artifactId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        slug: 'review-skill',
        version: '1.0.0',
        archiveChecksum: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        installedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    invalidateSkillsCache()
    const { invoke } = createHarness()
    const response = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'review-skill', source: 'workspace', enabled: false,
    })
    expect(response).toEqual({ ok: false, errorCode: 'managed_skill_not_toggleable' })
  })

  it('rejects a stale revision without writing', async () => {
    const { invoke } = createHarness()
    const first = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'review-skill', source: 'workspace', enabled: false,
    })
    expect(first.ok).toBe(true)
    const conflict = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'review-skill', source: 'workspace', enabled: true, expectedRevision: 0,
    })
    expect(conflict).toEqual({ ok: false, errorCode: 'revision_conflict', revision: 1 })
    const list = await invoke(RPC_CHANNELS.skills.LIST_MANAGED, { workspaceId: WORKSPACE_ID })
    expect(list.items.find((item: { slug: string }) => item.slug === 'review-skill').enabled).toBe(false)
  })

  it('refuses unknown skills and unknown workspaces', async () => {
    const { invoke } = createHarness()
    expect(await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'nope', source: 'workspace', enabled: false,
    })).toEqual({ ok: false, errorCode: 'skill_not_found' })
    expect(await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: 'ws-unknown', slug: 'review-skill', source: 'workspace', enabled: false,
    })).toEqual({ ok: false, errorCode: 'workspace_context_mismatch' })
  })

  it('refuses writes in the offline read-only view as a structured error (K4/N1)', async () => {
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'review-skill', source: 'workspace', enabled: false,
    })).resolves.toEqual({ ok: false, errorCode: 'OFFLINE_READ_ONLY' })
  })
})

describe('skills.getUnfiltered', () => {
  it('keeps a disabled row listed with its metadata while skills.GET filters it (B1)', async () => {
    const { invoke } = createHarness()
    const set = await invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
      workspaceId: WORKSPACE_ID, slug: 'review-skill', source: 'workspace', enabled: false,
    })
    expect(set.ok).toBe(true)
    const unfiltered = await invoke(RPC_CHANNELS.skills.GET_UNFILTERED, WORKSPACE_ID) as Array<{ slug: string; metadata: { name: string } }>
    expect(unfiltered.find(skill => skill.slug === 'review-skill')?.metadata.name).toBe('Review Skill')
    // The composer channel keeps the filtered view (SM-09) — only the
    // management workbench sees the disabled row.
    const filtered = await invoke(RPC_CHANNELS.skills.GET, WORKSPACE_ID) as Array<{ slug: string }>
    expect(filtered.map(skill => skill.slug)).not.toContain('review-skill')
  })

  it('returns an empty list for an unknown workspace and in the offline view', async () => {
    const { invoke } = createHarness()
    expect(await invoke(RPC_CHANNELS.skills.GET_UNFILTERED, 'ws-unknown')).toEqual([])
    setRuntimeOfflineReadOnly(true)
    expect(await invoke(RPC_CHANNELS.skills.GET_UNFILTERED, WORKSPACE_ID)).toEqual([])
  })
})

function SetSourceBundled(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): Promise<unknown> {
  return invoke(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, {
    workspaceId: WORKSPACE_ID, slug: 'bundled-only', source: 'bundled', enabled: false,
  })
}
