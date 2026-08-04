import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import type { Workspace } from '@polo-ai/core/types'
import {
  CREATOR_SKILL_FIXTURE_CONTENT,
  calculateContentDigest,
  type CreatorSkillOperationProgress,
} from '@z-h-ai/shared/creator-skills'
import { AdminClient } from '@z-h-ai/shared/admin'
import { getCredentialManager } from '@z-h-ai/shared/credentials'
import type { HandlerDeps } from '@polo-ai/server-core/handlers'
import { registerCoreRpcHandlers } from '@polo-ai/server-core/handlers/rpc'
import { bindClientActiveSession } from '@polo-ai/server-core/handlers/rpc/client-active-session'
import { WsRpcServer } from '@polo-ai/server-core/transport'

const preloadPath = process.argv[2]
const rendererHtmlPath = process.argv[3]
const adminBaseUrl = process.argv[4]
const workspaceRoot = process.argv[5]
const configDirectory = process.env.POLO_AI_CONFIG_DIR

if (
  !preloadPath
  || !rendererHtmlPath
  || !adminBaseUrl
  || !workspaceRoot
  || !configDirectory
) {
  throw new Error('Creator Skill E2E runtime configuration is incomplete')
}

const workspace: Workspace = {
  id: 'creator-skill-e2e-workspace',
  name: 'Creator Skill E2E',
  slug: 'creator-skill-e2e',
  rootPath: workspaceRoot,
  createdAt: Date.now(),
}
const sessionId = 'creator-skill-e2e-session'
const adminHttpClient = new AdminClient(adminBaseUrl)
let adminAccessToken = ''
const rpcServer = new WsRpcServer({
  host: '127.0.0.1',
  port: 0,
  onClientConnected(info) {
    if (info.workspaceId === workspace.id) {
      bindClientActiveSession(info.clientId, workspace.id, sessionId)
    }
  },
})

let window: BrowserWindow | null = null
let completed = false

function safeMethodProxy(overrides: Record<string, unknown>): object {
  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property === 'string' && property in target) {
        return target[property]
      }
      return () => undefined
    },
  })
}

function createHandlerDependencies(): HandlerDeps {
  const session = {
    id: sessionId,
    workspaceId: workspace.id,
    workingDirectory: workspace.rootPath,
  }
  const sessionManager = safeMethodProxy({
    waitForInit: async () => {},
    getWorkspaces: () => [workspace],
    getSessions: () => [session],
    getSession: async (id: string) => (id === sessionId ? session : null),
    getUnreadSummary: () => ({ totalUnread: 0, byWorkspace: {} }),
    setupConfigWatcher: () => {},
    clearActiveViewingSession: () => {},
    getSessionPermissionModeState: async () => ({ mode: 'ask', modeVersion: 0 }),
  })
  const windowManager = safeMethodProxy({
    getWorkspaceForWindow: () => workspace.id,
    updateWindowWorkspace: () => true,
    registerWindow: () => {},
    getWindowByWebContentsId: () => window,
    getAllWindowsForWorkspace: () => (window ? [window] : []),
  })
  const browserPaneManager = safeMethodProxy({
    listInstances: () => [],
    getInstances: () => [],
  })

  return {
    sessionManager,
    oauthFlowStore: safeMethodProxy({}),
    windowManager,
    browserPaneManager,
    platform: {
      appRootPath: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      appVersion: '0.0.0-creator-skill-e2e',
      isDebugMode: true,
      logger: {
        info: (...args: unknown[]) => console.log(...args),
        warn: (...args: unknown[]) => console.warn(...args),
        error: (...args: unknown[]) => console.error(...args),
        debug: () => {},
      },
      getAdminAccessToken: () => adminAccessToken,
      systemDarkMode: () => false,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  } as unknown as HandlerDeps
}

function installBootstrapIpc(): void {
  ipcMain.on('__get-web-contents-id', event => {
    event.returnValue = event.sender.id
  })
  ipcMain.on('__get-ws-port', event => {
    event.returnValue = rpcServer.port
  })
  ipcMain.on('__get-ws-token', event => {
    event.returnValue = ''
  })
  ipcMain.on('__get-workspace-id', event => {
    event.returnValue = workspace.id
  })
  ipcMain.on('__get-workspace-remote-config', event => {
    event.returnValue = null
  })
  ipcMain.handle('__dialog:showMessageBox', async () => ({
    response: 0,
    checkboxChecked: false,
  }))
  ipcMain.handle('__dialog:showOpenDialog', async () => ({
    canceled: true,
    filePaths: [],
  }))
  ipcMain.handle('__browser:invoke', async () => null)
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function evaluate<T>(source: string): Promise<T> {
  if (!window) throw new Error('Creator Skill E2E window is unavailable')
  return window.webContents.executeJavaScript(source, true) as Promise<T>
}

async function rendererCall<T>(body: string): Promise<T> {
  return evaluate<T>(`(async () => { ${body} })()`)
}

async function rendererAdminCall<T>(method: string, ...args: unknown[]): Promise<T> {
  const serializedArgs = args.map(arg => JSON.stringify(arg)).join(', ')
  return rendererCall<T>(`return await window.electronAPI.${method}(${serializedArgs})`)
}

function logStep(step: string): void {
  console.log(JSON.stringify({ event: 'creator_skill_step', step }))
}

function createSkillArchive(content: string): Uint8Array {
  return zipSync({
    [`${workspace.slug}/SKILL.md`]: strToU8(content),
  })
}

function makeChangelog(version: string): string {
  return version === '1.0.0'
    ? 'Initial release'
    : `Update ${version}`
}

async function login(identifier: string, password: string): Promise<void> {
  logStep(`login-start:${identifier}`)
  const result = await adminHttpClient.login(identifier, password)
  adminAccessToken = result.accessToken
  await getCredentialManager().setAdminTokens({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: Date.now() + (result.expiresIn * 1000),
    userId: result.user.id,
    username: result.user.username,
    displayName: result.user.displayName ?? undefined,
  })
  logStep(`login-done:${identifier}`)
}

async function logout(): Promise<void> {
  await getCredentialManager().deleteAdminTokens()
}

async function createOrganization(): Promise<{ id: string }> {
  logStep('create-organization-start')
  const result = await rendererAdminCall<{
    success: boolean
    organization?: { id: string }
  }>('organizationCreate', {
    type: 'creator_space',
    name: 'Creator Skill E2E',
    purpose: 'Validate creator skill lifecycle',
    idempotencyKey: `creator-skill-org-${randomUUID()}`,
  })
  if (!result.success || !result.organization) {
    throw new Error('Failed to create creator space organization')
  }
  logStep('create-organization-done')
  return { id: result.organization.id }
}

async function createJoinLink(organizationId: string): Promise<string> {
  const result = await rendererAdminCall<{
    success: boolean
    token?: string
  }>('organizationCreateJoinLink', organizationId, { maxUses: 2 })
  if (!result.success || !result.token) {
    throw new Error('Failed to create organization join link')
  }
  return result.token
}

async function acceptJoin(token: string): Promise<void> {
  const result = await rendererAdminCall<{ success: boolean }>('organizationAcceptJoin', token)
  if (!result.success) {
    throw new Error('Failed to accept organization join')
  }
}

async function updateMemberRole(
  organizationId: string,
  username: string,
  role: 'manager' | 'member',
): Promise<void> {
  const members = await rendererAdminCall<{
    success: boolean
    members?: Array<{ id: string; user: { username: string } }>
  }>('organizationListMembers', organizationId)
  if (!members.success || !members.members) {
    throw new Error(`Missing organization members response for ${organizationId}`)
  }
  const member = members.members.find(item => item.user.username === username)
  if (!member) {
    throw new Error(`Missing organization member for ${username}`)
  }
  const result = await rendererAdminCall<{ success: boolean }>(
    'organizationUpdateMember',
    organizationId,
    member.id,
    { role },
  )
  if (!result.success) {
    throw new Error(`Failed to update organization member ${username}`)
  }
}

async function createArtifact(organizationId: string, slug: string): Promise<{ id: string }> {
  const result = await rendererAdminCall<{
    success: boolean
    artifact?: { id: string }
  }>('creatorArtifactCreate', {
    organizationId,
    type: 'skill',
    slug,
    idempotencyKey: `creator-skill-artifact-${randomUUID()}`,
  })
  if (!result.success || !result.artifact?.id) {
    throw new Error('Failed to create creator skill draft')
  }
  return { id: result.artifact.id }
}

async function createVersion(
  organizationId: string,
  artifactId: string,
  version: string,
  changelog: string,
): Promise<{
  versionId: string
  version: string
  upload: {
    method: 'PUT'
    url: string
    headers?: Record<string, string>
    expiresAt: string
    uploadGeneration: number
  }
}> {
  const versionResult = await rendererAdminCall<{
    success: boolean
    version?: { id: string }
    upload?: {
      method: 'PUT'
      url: string
      headers?: Record<string, string>
      expiresAt: string
      uploadGeneration: number
    }
  }>('creatorArtifactCreateVersion', {
    organizationId,
    artifactId,
    version,
    changelog,
    idempotencyKey: `creator-skill-version-${randomUUID()}`,
  })
  if (!versionResult.success || !versionResult.version?.id || !versionResult.upload) {
    throw new Error(`Failed to create version ${version}`)
  }
  return { versionId: versionResult.version.id, version, upload: versionResult.upload }
}

async function uploadVersion(
  organizationId: string,
  artifactId: string,
  version: string,
  archiveContent: string,
  upload: {
    method: 'PUT'
    url: string
    headers?: Record<string, string>
    expiresAt: string
    uploadGeneration: number
  },
): Promise<{ archiveChecksum: string; contentDigest: string }> {
  const archive = createSkillArchive(archiveContent)
  const archiveChecksum = createHash('sha256').update(archive).digest('hex')
  const contentDigest = calculateContentDigest([{
    path: 'SKILL.md',
    size: new TextEncoder().encode(archiveContent).byteLength,
    sha256: createHash('sha256').update(archiveContent).digest('hex'),
  }])
  const uploadResult = await rendererCall<{ ok: boolean }>(`
    const base64 = ${JSON.stringify(Buffer.from(archive).toString('base64'))}
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const file = new File([bytes], 'creator-skill.zip', { type: 'application/zip' })
    const headers = ${JSON.stringify({
      Authorization: `Bearer ${adminAccessToken}`,
      ...(upload.headers ?? {}),
    })}
    const response = await fetch(${JSON.stringify(upload.url)}, {
      method: ${JSON.stringify(upload.method)},
      headers,
      body: file,
      redirect: 'error',
    })
    return { ok: response.ok }
  `)
  if (!uploadResult.ok) {
    throw new Error('Creator skill upload PUT failed in renderer')
  }

  const completeResult = await rendererAdminCall<{
    success: boolean
  }>('creatorArtifactCompleteUpload', {
    organizationId,
    artifactId,
    version,
    uploadGeneration: upload.uploadGeneration,
    sizeBytes: archive.length,
    idempotencyKey: `creator-skill-complete-${randomUUID()}`,
  })
  if (!completeResult.success) {
    throw new Error('Creator skill upload completion failed')
  }

  return { archiveChecksum, contentDigest }
}

async function waitForValidatedVersion(
  organizationId: string,
  artifactId: string,
  version: string,
): Promise<void> {
  await waitFor(`validated version ${version}`, async () => {
    const detail = await rendererAdminCall<{
      success: boolean
      versions?: Array<{ version: string; status: string }>
    }>('creatorArtifactGet', {
      organizationId,
      artifactId,
      version,
    })
    return detail.success
      && detail.versions?.some(item => item.version === version && item.status === 'validated') === true
  })
}

async function attemptMemberAccessBeforePublish(
  organizationId: string,
  artifactId: string,
  version: string,
): Promise<void> {
  const capability = await rendererAdminCall<{
    success: boolean
    creatorSkillArtifacts?: boolean
  }>('creatorArtifactGetCapabilities')
  if (!capability.success || capability.creatorSkillArtifacts !== true) {
    throw new Error('Creator Skill capability was not available before publish')
  }
  const list = await rendererAdminCall<{
    success: boolean
    artifacts?: Array<{ id: string }>
  }>('creatorArtifactList', {
    organizationId,
    type: 'skill',
    includeDrafts: true,
  })
  if (!list.success) {
    throw new Error('Member catalog list failed before publish')
  }
  if (list.artifacts?.some(item => item.id === artifactId)) {
    throw new Error('Member unexpectedly saw draft artifact before publish')
  }

  const grantResponse = await rendererAdminCall<{
    success: boolean
  }>('creatorSkillGetDownloadGrant', {
    organizationId,
    artifactId,
    version,
  })
  if (grantResponse.success) {
    throw new Error('Member unexpectedly received a download grant before publish')
  }
}

async function publishVersion(
  organizationId: string,
  artifactId: string,
  version: string,
): Promise<void> {
  const result = await rendererAdminCall<{
    success: boolean
    version?: { id: string }
  }>('creatorArtifactPublishVersion', {
    organizationId,
    artifactId,
    version,
    idempotencyKey: `creator-skill-publish-${randomUUID()}`,
  })
  if (!result.success || !result.version?.id) {
    throw new Error('Creator skill publish failed')
  }
}

async function installVersion(
  workspaceId: string,
  grant: {
    artifactId: string
    organizationId: string
    slug: string
    version: string
    url: string
    expiresAt: string
    archiveChecksum: string
    contentDigest: string
    manifest: Array<{ path: string; size: number; sha256: string }>
    validationPolicy: unknown
  },
): Promise<void> {
  const operationId = randomUUID()
  const result = await rendererCall<{
    success: boolean
    stage?: string
    conflicts?: unknown[]
  }>(`
    return await window.electronAPI.creatorSkillInstall({
      workspaceId: ${JSON.stringify(workspaceId)},
      operationId: ${JSON.stringify(operationId)},
      grant: ${JSON.stringify(grant)},
    })
  `)
  if (!result.success) {
    throw new Error(`Creator skill install failed: ${JSON.stringify(result)}`)
  }
}

async function uninstallSkill(workspaceId: string, slug: string): Promise<void> {
  const result = await rendererCall<{
    success: boolean
  }>(`
    return await window.electronAPI.creatorSkillUninstall({
      workspaceId: ${JSON.stringify(workspaceId)},
      operationId: ${JSON.stringify(randomUUID())},
      slug: ${JSON.stringify(slug)},
    })
  `)
  if (!result.success) {
    throw new Error('Creator skill uninstall failed')
  }
}

async function readRendererHarnessState(): Promise<{
  progress: CreatorSkillOperationProgress[]
  skillsChanged: Array<{ workspaceId: string; skills: unknown[] }>
}> {
  return rendererCall(`
    return window.__creatorSkillHarnessState
  `)
}

async function run(): Promise<void> {
  logStep('bootstrap')
  mkdirSync(workspace.rootPath, { recursive: true })
  mkdirSync(join(workspace.rootPath, 'skills'), { recursive: true })
  registerCoreRpcHandlers(rpcServer, createHandlerDependencies())
  await rpcServer.listen()
  installBootstrapIpc()

  window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
    },
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.warn('[creator-skill-renderer]', message)
  })
  await window.loadFile(rendererHtmlPath)
  await waitFor('electronAPI bootstrap', () => evaluate<boolean>(
    `Boolean(window.electronAPI?.adminLogin && window.electronAPI?.creatorArtifactList)`,
  ))
  logStep('renderer-ready')
  await rendererCall(`
    window.__creatorSkillHarnessState = {
      progress: [],
      skillsChanged: [],
    }
    window.electronAPI.onCreatorSkillProgress(progress => {
      window.__creatorSkillHarnessState.progress.push(progress)
    })
    window.electronAPI.onSkillsChanged((workspaceId, skills) => {
      window.__creatorSkillHarnessState.skillsChanged.push({ workspaceId, skills })
    })
    return true
  `)

  logStep('alice-login-org')
  await login('alice', 'alice-password-123')
  const organization = await createOrganization()
  const joinToken = await createJoinLink(organization.id)

  logStep('bob-join')
  await logout()
  await login('bob', 'bob-password-123')
  await acceptJoin(joinToken)

  logStep('draft-upload')
  await logout()
  await login('alice', 'alice-password-123')
  const artifact = await createArtifact(organization.id, workspace.slug)
  const versionOne = await createVersion(
    organization.id,
    artifact.id,
    '1.0.0',
    makeChangelog('1.0.0'),
  )
  const versionOnePackage = await uploadVersion(
    organization.id,
    artifact.id,
    versionOne.version,
    CREATOR_SKILL_FIXTURE_CONTENT,
    versionOne.upload,
  )
  await waitForValidatedVersion(organization.id, artifact.id, '1.0.0')

  logStep('member-prepublish')
  await logout()
  await login('bob', 'bob-password-123')
  await attemptMemberAccessBeforePublish(organization.id, artifact.id, '1.0.0')

  logStep('manager-publish')
  await logout()
  await login('alice', 'alice-password-123')
  await updateMemberRole(organization.id, 'bob', 'manager')

  await logout()
  await login('bob', 'bob-password-123')
  {
    const capability = await rendererAdminCall<{ success: boolean; creatorSkillArtifacts?: boolean }>(
      'creatorArtifactGetCapabilities',
    )
    if (!capability.success || capability.creatorSkillArtifacts !== true) {
      throw new Error('Creator Skill capability was not available to the manager')
    }
    const response = await rendererAdminCall<{
      success: boolean
      artifacts?: Array<{ id: string; latestPublishedVersion?: string }>
      nextCursor?: string
    }>('creatorArtifactList', {
      organizationId: organization.id,
      type: 'skill',
      includeDrafts: true,
    })
    if (!response.success || !response.artifacts?.some(item => item.id === artifact.id)) {
      throw new Error('Manager could not see the draft artifact')
    }
  }
  await publishVersion(organization.id, artifact.id, versionOne.version)

  logStep('manager-visible')
  {
    const response = await rendererAdminCall<{
      success: boolean
      artifacts?: Array<{ id: string; latestPublishedVersion?: string }>
      nextCursor?: string
    }>('creatorArtifactList', {
      organizationId: organization.id,
      type: 'skill',
      includeDrafts: true,
    })
    if (!response.success || !response.artifacts?.some(item => item.id === artifact.id)) {
      throw new Error('Manager could not see the published skill')
    }
  }

  logStep('member-download')
  await logout()
  await login('alice', 'alice-password-123')
  await updateMemberRole(organization.id, 'bob', 'member')

  await logout()
  await login('bob', 'bob-password-123')
  {
    const response = await rendererAdminCall<{
      success: boolean
      artifacts?: Array<{ id: string; latestPublishedVersion?: string }>
      nextCursor?: string
    }>('creatorArtifactList', {
      organizationId: organization.id,
      type: 'skill',
      includeDrafts: true,
    })
    if (!response.success || !response.artifacts?.some(item => item.id === artifact.id)) {
      throw new Error('Member could not see the published skill')
    }
  }
  {
    const response = await rendererAdminCall<{
      success: boolean
      artifact?: { id: string; slug: string; latestPublishedVersion?: string }
      versions?: Array<{ version: string; status: string }>
    }>('creatorArtifactGet', {
      organizationId: organization.id,
      artifactId: artifact.id,
      version: '1.0.0',
    })
    if (!response.success || response.artifact?.latestPublishedVersion !== '1.0.0') {
      throw new Error('Published artifact detail is incorrect')
    }
  }
  {
    const response = await rendererAdminCall<{
      success: boolean
      status?: string
    }>('creatorSkillGetSafetyStatus', {
      artifactId: artifact.id,
      version: '1.0.0',
      archiveChecksum: versionOnePackage.archiveChecksum,
    })
    if (!response.success || response.status !== 'active') {
      throw new Error('Published skill safety status is not active')
    }
  }
  logStep('install-update')
  const target = await rendererCall<{ success: boolean; name?: string; path?: string; writable?: boolean }>(`
    return await window.electronAPI.creatorSkillGetTarget({
      workspaceId: ${JSON.stringify(workspace.id)},
    })
  `)
  if (!target.success || !target.writable || target.path !== workspace.rootPath) {
    throw new Error('Workspace target is not writable or mismatched')
  }

  const downloadGrantOne = await rendererAdminCall<{
    artifactId?: string
    organizationId?: string
    slug?: string
    version?: string
    url?: string
    expiresAt?: string
    archiveChecksum?: string
    contentDigest?: string
    manifest?: Array<{ path: string; size: number; sha256: string }>
    validationPolicy?: unknown
    success: boolean
  }>('creatorSkillGetDownloadGrant', {
    organizationId: organization.id,
    artifactId: artifact.id,
    version: '1.0.0',
  })
  if (!downloadGrantOne.success || !downloadGrantOne.url || !downloadGrantOne.archiveChecksum || !downloadGrantOne.contentDigest) {
    throw new Error('Published version download grant was not issued')
  }

  await rendererCall(`
    if (!window.__creatorSkillHarnessState) throw new Error('Harness state missing')
    return true
  `)
  await installVersion(workspace.id, {
    artifactId: downloadGrantOne.artifactId!,
    organizationId: downloadGrantOne.organizationId!,
    slug: downloadGrantOne.slug!,
    version: downloadGrantOne.version!,
    url: downloadGrantOne.url!,
    expiresAt: downloadGrantOne.expiresAt!,
    archiveChecksum: downloadGrantOne.archiveChecksum!,
    contentDigest: downloadGrantOne.contentDigest!,
    manifest: downloadGrantOne.manifest ?? [],
    validationPolicy: downloadGrantOne.validationPolicy,
  })

  // Publishing remains a manager operation; the member that installed the
  // first release must not be able to create the update.
  await logout()
  await login('alice', 'alice-password-123')
  const versionTwo = await createVersion(
    organization.id,
    artifact.id,
    '1.1.0',
    makeChangelog('1.1.0'),
  )
  const updatedContent = CREATOR_SKILL_FIXTURE_CONTENT.replace(
    'Reviews changes against a checklist.',
    'Reviews changes against a checklist and release flow.',
  )
  await uploadVersion(
    organization.id,
    artifact.id,
    versionTwo.version,
    updatedContent,
    versionTwo.upload,
  )
  await waitForValidatedVersion(organization.id, artifact.id, '1.1.0')
  await publishVersion(organization.id, artifact.id, versionTwo.version)

  await logout()
  await login('bob', 'bob-password-123')
  const downloadGrantTwo = await rendererAdminCall<{
    success: boolean
    artifactId?: string
    organizationId?: string
    slug?: string
    version?: string
    url?: string
    expiresAt?: string
    archiveChecksum?: string
    contentDigest?: string
    manifest?: Array<{ path: string; size: number; sha256: string }>
    validationPolicy?: unknown
  }>('creatorSkillGetDownloadGrant', {
    organizationId: organization.id,
    artifactId: artifact.id,
    version: '1.1.0',
  })
  if (!downloadGrantTwo.success || !downloadGrantTwo.url || !downloadGrantTwo.archiveChecksum || !downloadGrantTwo.contentDigest) {
    throw new Error('Updated version download grant was not issued')
  }

  await installVersion(workspace.id, {
    artifactId: downloadGrantTwo.artifactId!,
    organizationId: downloadGrantTwo.organizationId!,
    slug: downloadGrantTwo.slug!,
    version: downloadGrantTwo.version!,
    url: downloadGrantTwo.url!,
    expiresAt: downloadGrantTwo.expiresAt!,
    archiveChecksum: downloadGrantTwo.archiveChecksum!,
    contentDigest: downloadGrantTwo.contentDigest!,
    manifest: downloadGrantTwo.manifest ?? [],
    validationPolicy: downloadGrantTwo.validationPolicy,
  })

  const installedSkillPath = join(workspace.rootPath, 'skills', workspace.slug, 'SKILL.md')
  if (!existsSync(installedSkillPath)) {
    throw new Error('Installed Creator Skill path is missing')
  }
  const installedContent = readFileSync(installedSkillPath, 'utf8')
  if (!installedContent.includes('release flow')) {
    throw new Error('Installed Creator Skill content was not updated to the latest published version')
  }

  const backups = await rendererCall<{ success: boolean; backups?: Array<{ slug: string }> }>(`
    return await window.electronAPI.creatorSkillListBackups({
      workspaceId: ${JSON.stringify(workspace.id)},
    })
  `)
  if (!backups.success || !backups.backups?.length) {
    throw new Error('Expected an installed Creator Skill backup after update')
  }

  await uninstallSkill(workspace.id, workspace.slug)
  if (existsSync(join(workspace.rootPath, 'skills', workspace.slug))) {
    throw new Error('Uninstall left the formal skill path behind')
  }

  const finalBackups = await rendererCall<{ success: boolean; backups?: Array<{ slug: string }> }>(`
    return await window.electronAPI.creatorSkillListBackups({
      workspaceId: ${JSON.stringify(workspace.id)},
    })
  `)
  if (!finalBackups.success || !finalBackups.backups?.length) {
    throw new Error('Expected cleanup-safe backups to remain after uninstall')
  }

  logStep('done')
  const harnessState = await readRendererHarnessState()
  const stages = new Set(harnessState.progress.map(entry => entry.stage))
  for (const stage of ['download', 'validate', 'prepare', 'commit', 'refresh'] as const) {
    if (!stages.has(stage)) {
      throw new Error(`Missing install progress stage: ${stage}`)
    }
  }
  if (harnessState.skillsChanged.length < 3) {
    throw new Error('Expected skills:changed broadcasts for install, update, and uninstall')
  }
  if (!harnessState.skillsChanged.every(entry => entry.workspaceId === workspace.id)) {
    throw new Error('skills:changed broadcast targeted the wrong workspace')
  }

  completed = true
  console.log(JSON.stringify({
    event: 'creator_skill_e2e_pass',
    adminBaseUrl,
    organizationId: organization.id,
    artifactId: artifact.id,
    workspace: {
      id: workspace.id,
      rootPath: workspace.rootPath,
    },
    roles: [
      'alice owner created artifact and approved membership changes',
      'bob member could not download draft content',
      'bob manager published both released versions',
      'admin member installed the published skill',
    ],
    versions: [
      { version: '1.0.0', archiveChecksum: downloadGrantOne.archiveChecksum, contentDigest: downloadGrantOne.contentDigest },
      { version: '1.1.0', archiveChecksum: downloadGrantTwo.archiveChecksum, contentDigest: downloadGrantTwo.contentDigest },
    ],
    installEvidence: {
      progressStages: [...stages],
      skillsChangedCount: harnessState.skillsChanged.length,
      backupsCount: finalBackups.backups.length,
    },
  }))
  app.quit()
}

const timeout = setTimeout(() => {
  if (!completed) {
    console.error('Creator Skill Electron E2E timed out')
    app.exit(1)
  }
}, 300_000)

app.whenReady().then(run).catch(error => {
  console.error(error)
  app.exit(1)
})

app.on('will-quit', () => {
  clearTimeout(timeout)
  rpcServer.close()
})
