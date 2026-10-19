/**
 * Regression tests for the bundled-skill DELETE guard (POO-110 S1 fix).
 *
 * The guard must only refuse deletion when the visible skill really is the
 * app-shipped bundled one. A user-owned workspace Skill with the same slug is
 * a regular user asset: deleting it removes just that copy, keeps the bundled
 * original in place, and the bundled skill becomes discoverable again.
 *
 * Exercises the real skills RPC handlers over a real workspace directory —
 * not a source-text check. Bind: POO-110 S1 fix commit on top of 97244a20.
 */
import { expect, it } from 'bun:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@polo-ai/core/types'
import type { HandlerFn, RequestContext, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { registerSkillsHandlers } from '../skills'
import { clearBundledAssetsRoot, getBundledAssetsRoot, setBundledAssetsRoot } from '@polo-ai/shared/utils/paths'
import { invalidateSkillsCache } from '@polo-ai/shared/skills'
import { bindCanonicalSkillContextResolver } from '../../../runtime/canonical-skills'
import { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount, setRuntimeOfflineReadOnly } from '../../../runtime/product-space-executions'
import { setSyncTrustedProductSpaceAccountId, setTrustedProductSpaceAccountProvider } from '../trusted-product-space-account'

const temporaryRoot = await mkdtemp(join(tmpdir(), 'skills-bundled-delete-'))
process.env.POLO_AI_CONFIG_DIR = join(temporaryRoot, 'private-config')
await mkdir(process.env.POLO_AI_CONFIG_DIR, { recursive: true })

const trustedAccountId = 'bundled-delete-account'
const productSpaceId = 'bundled-delete-space'
const workspace: Workspace = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Bundled Delete Workspace',
  slug: 'bundled-delete-workspace',
  rootPath: join(temporaryRoot, 'workspace'),
  createdAt: Date.now(),
}
await mkdir(workspace.rootPath)

const handlers = new Map<string, HandlerFn>()
const server: RpcServer = {
  handle(channel, handler) { handlers.set(channel, handler) },
  push() {},
  async invokeClient() { return undefined },
  hasClientCapability() { return false },
  findClientsWithCapability() { return [] },
}
registerSkillsHandlers(server, {
  sessionManager: {
    getWorkspaces: () => [workspace],
    getSession: async () => null,
    getSessions: () => [],
  },
  platform: { appRootPath: temporaryRoot, resourcesPath: temporaryRoot, isPackaged: false },
} as unknown as HandlerDeps)

const ctx: RequestContext = {
  clientId: 'bundled-delete-client',
  workspaceId: workspace.id,
  webContentsId: null,
  signal: new AbortController().signal,
}

bindCanonicalSkillContextResolver(async scope => ({ id: scope.productSpaceId, kind: 'personal', accessMode: 'active' }) as never)
setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
setSyncTrustedProductSpaceAccountId(trustedAccountId)
setRuntimeActiveProductSpaceAccount(trustedAccountId)
setRuntimeActiveProductSpace(productSpaceId)
setRuntimeOfflineReadOnly(false)

const previousAssetsRoot = getBundledAssetsRoot()
const assets = join(temporaryRoot, 'assets')
const slug = 'polo-upload-app'
const builtinFile = join(assets, 'resources', 'builtin-skills', slug, 'SKILL.md')
const userFile = join(workspace.rootPath, 'skills', slug, 'SKILL.md')
const exists = (path: string) => access(path).then(() => true, () => false)

await mkdir(join(assets, 'resources', 'builtin-skills', slug), { recursive: true })
await writeFile(builtinFile, '---\nname: "Upload an App to Polo"\ndescription: "Built-in guide."\n---\nBundled instructions.')
setBundledAssetsRoot(assets)

it('deleting a user workspace override of a bundled slug removes only the user copy and the built-in skill is rediscoverable', async () => {
  invalidateSkillsCache()
  await mkdir(join(workspace.rootPath, 'skills', slug), { recursive: true })
  await writeFile(userFile, '---\nname: "user-upload"\ndescription: "User override."\n---\nUser instructions.')

  const rows = await handlers.get(RPC_CHANNELS.skills.GET)!(ctx, workspace.id) as Array<{ slug: string; source: string }>
  expect(rows.find(row => row.slug === slug)?.source).toBe('workspace')

  const result = await handlers.get(RPC_CHANNELS.skills.DELETE)!(ctx, { workspaceId: workspace.id, skillSlug: slug })
  expect(result).toMatchObject({ managed: false, detached: false })

  expect(await exists(userFile)).toBe(false)
  expect(await exists(builtinFile)).toBe(true)

  const after = await handlers.get(RPC_CHANNELS.skills.GET)!(ctx, workspace.id) as Array<{ slug: string; source: string }>
  expect(after.find(row => row.slug === slug)?.source).toBe('bundled')
})

it('a pure bundled slug (no user copy) still refuses deletion and keeps its file', async () => {
  invalidateSkillsCache()
  const result = await handlers.get(RPC_CHANNELS.skills.DELETE)!(ctx, { workspaceId: workspace.id, skillSlug: slug })
  expect(result).toBe(false)
  expect(await exists(builtinFile)).toBe(true)
})

it('deleting an unrelated slug without any copy still reports no deletion', async () => {
  invalidateSkillsCache()
  const result = await handlers.get(RPC_CHANNELS.skills.DELETE)!(ctx, { workspaceId: workspace.id, skillSlug: 'never-existed' })
  expect(result).toMatchObject({ managed: false, detached: false })
  expect(await exists(join(workspace.rootPath, 'skills', 'never-existed'))).toBe(false)
})

import { afterAll } from 'bun:test'
afterAll(async () => {
  if (previousAssetsRoot === undefined) clearBundledAssetsRoot()
  else setBundledAssetsRoot(previousAssetsRoot)
  invalidateSkillsCache()
  await rm(temporaryRoot, { recursive: true, force: true })
})
