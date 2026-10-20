import { basename, dirname, join, resolve, sep } from 'path'
import { constants as fsConstants, existsSync, readdirSync, statSync } from 'fs'
import { access, realpath, stat } from 'node:fs/promises'
import { RPC_CHANNELS, type SkillFile } from '@polo-ai/shared/protocol'
import { getAdminUrl } from '@polo-ai/shared/config'
import {
  CLIENT_CREATOR_SKILL_COMMIT_CHECK,
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@polo-ai/server-core/transport'
import { CredentialManager } from '@polo-ai/shared/credentials'
import type { HandlerDeps } from '../handler-deps'
import { resolveTrustedProductSpaceAccountId } from './trusted-product-space-account'
import { prepareNativeCanonicalSkillInstall, prepareNativeSkillInstall, prepareNativeSkillUninstall, finishNativeSkillInstallation, flushNativeSkillInstallationEvidence, recoverNativeSkillInstallationEvidence } from '../../runtime/native-skill-installation-evidence'
import {
  getRuntimeActiveProductSpace,
  getRuntimeFenceGeneration,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  isRuntimeProductSpaceRestricted,
} from '../../runtime/product-space-executions'
import {
  CreatorSkillBackupDeleteRpcInputSchema,
  CreatorSkillBackupRpcInputSchema,
  CreatorSkillInstallRpcInputSchema,
  CreatorSkillIgnoreVersionRpcInputSchema,
  CreatorSkillOperationIdSchema,
  CreatorSkillStatusUpdateRpcInputSchema,
  CreatorSkillTargetRpcInputSchema,
  CreatorSkillUninstallRpcInputSchema,
  DeleteSkillRpcInputSchema,
  cancelCreatorSkillOperation,
  deleteCreatorSkillBackups,
  hasPendingCreatorSkillForceDelete,
  installCreatorSkill,
  listCreatorSkillBackups,
  readCreatorSkillsLedger,
  recoverCreatorSkillOperations,
  uninstallCreatorSkill,
  updateCreatorSkillInstallationMetadata,
} from '@polo-ai/shared/creator-skills'
import { resolveCanonicalSkill, canonicalSkillSourceFromLaunch, loadProductSpaceSkills, discoverProductSpaceSkills } from '../../runtime/canonical-skills'
import {
  readDisabledManagedSkillSlugs,
  readManagedSkillEnablementDocument,
  setManagedSkillsRoot,
  writeManagedSkillEnablement,
} from '../../runtime/managed-skill-enablement'
import { readCanonicalSkillInstallations, installCanonicalSkill, canonicalSkillRoot, canonicalSkillIdentity, listCanonicalSkillRoots, recoverCanonicalSkillOperations } from '@polo-ai/shared/creator-skills'
import { CatalogEntryIdSchema } from '@polo-ai/shared/product-spaces'
import {
  ListManagedSkillsRequestSchema,
  SetManagedSkillEnablementRequestSchema,
  isCanonicalManagedSkill,
  managedSkillEnablementError,
} from '@polo-ai/shared/skills'
import type { LoadedSkill, ManagedSkillStatus } from '@polo-ai/shared/skills'
import { getClientActiveSession } from './client-active-session'
import {
  EXECUTION_STOP_DRAIN_TIMEOUT_MS,
  EXECUTION_STOP_POLL_INTERVAL_MS,
  registerProductSpaceExecution,
  unregisterProductSpaceExecution,
  type RegisteredProductSpaceExecution,
} from '../../runtime/product-space-executions'
import {
  ExecutionIdSchema,
  PRODUCT_SPACE_CONTRACT_VERSION,
  ProductSpaceExecutionScopeSchema,
} from '@polo-ai/shared/product-spaces'
import type { ExecutionStatus } from '@polo-ai/shared/product-spaces'

function currentWorkspaceId(ctx: RequestContext, deps: HandlerDeps): string | null {
  if (ctx.workspaceId) return ctx.workspaceId
  if (ctx.webContentsId === null) return null
  return deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? null
}

/**
 * R33-2: an in-flight Creator Skill install/uninstall is a ProductSpace
 * execution like any other. It is registered under its immutable trusted
 * account/ProductSpace/Workspace scope BEFORE the awaited operation starts,
 * exposes a real status ('running', 'stopping' once cancellation was
 * requested) and a bounded cancellation (the shared Creator Skill
 * cancellation controller + the shared stop drain deadline), so a
 * read_only-restricted transition terminates Skill work through the same
 * no-confirmation trusted path as Assistant and Local App executions and
 * the restricted projection only becomes usable once every execution is
 * terminal. `settle()` must run when the awaited operation completes.
 */
function registerSkillOperationExecution(input: {
  accountId: string
  productSpaceId: string
  workspaceId: string
  workspaceRoot: string
  operationOwnerId: string
  operationId: string
  slug: string
  version?: string
  subject?: { kind: 'artifact_instance'; artifactType: 'skill'; artifactInstanceId: string; versionId: string; version: string }
  cancelDownload?: () => void
  executionId?: string
}): { settle: () => void } {
  let settled = false
  let cancelRequested = false
  const executionId = ExecutionIdSchema.parse(input.executionId ?? `skill-op:${input.operationId}`)
  // R34 minor: the scope is validated through the shared runtime schema —
  // no double assertions, no malformed identifiers can reach the registry.
  const scope = ProductSpaceExecutionScopeSchema.parse({
    contractVersion: PRODUCT_SPACE_CONTRACT_VERSION,
    executionId,
    accountId: input.accountId,
    productSpaceId: input.productSpaceId,
    workspaceId: input.workspaceId,
    subject: input.subject ?? {
      kind: 'artifact_instance',
      artifactType: 'skill',
      artifactInstanceId: input.slug,
      versionId: input.version ?? input.slug,
      version: input.version ?? input.slug,
    },
  })
  const execution: RegisteredProductSpaceExecution = {
    scope,
    kind: 'skill_operation',
    name: input.slug,
    ref: input.operationId,
    generation: 0,
    isActive: () => !settled,
    getStatus: (): ExecutionStatus => (cancelRequested ? 'stopping' : 'running'),
    stop: async () => {
      cancelRequested = true
      input.cancelDownload?.()
      try {
        await cancelCreatorSkillOperation(
          input.workspaceRoot,
          input.operationOwnerId,
          input.operationId,
        )
      } catch {
        // The bounded drain below decides the outcome.
      }
      const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS
      while (!settled && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, EXECUTION_STOP_POLL_INTERVAL_MS))
      }
      return settled ? 'stopped' as const : 'failed' as const
    },
  }
  registerProductSpaceExecution(execution)
  return {
    settle: () => {
      settled = true
      unregisterProductSpaceExecution(executionId)
    },
  }
}

function getBoundWorkspace(
  ctx: RequestContext,
  requestedWorkspaceId: string,
  deps: HandlerDeps,
) {
  const activeId = currentWorkspaceId(ctx, deps)
  if (!activeId || activeId !== requestedWorkspaceId) return null
  const exactMatches = (deps.sessionManager.getWorkspaces?.() ?? [])
    .filter(workspace => workspace.id === activeId)
  return exactMatches.length === 1 ? exactMatches[0] ?? null : null
}

export async function hasWorkspaceSkillWriteAccess(workspaceRoot: string): Promise<boolean> {
  const paths = [
    workspaceRoot,
    join(workspaceRoot, 'skills'),
    join(workspaceRoot, '.creator-skill-ops'),
    join(workspaceRoot, '.creator-skill-force-delete.json'),
    join(workspaceRoot, 'creator-skills.json'),
  ].filter(path => path === workspaceRoot || existsSync(path))
  try {
    await Promise.all(paths.map(path => access(path, fsConstants.W_OK)))
    return true
  } catch {
    return false
  }
}

function workspaceMutationError(
  operationId: string,
  errorCode: 'workspace_context_mismatch' | 'workspace_read_only' | 'VALIDATION_ERROR',
) {
  return {
    success: false as const,
    operationId,
    errorCode,
    stage: 'prepare' as const,
    diagnostic: JSON.stringify({ errorCode, stage: 'prepare' }),
    retryable: false,
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function shouldAttachAdminAuth(requestUrl: string, adminOrigin: string): boolean {
  const request = new URL(requestUrl)
  const admin = new URL(adminOrigin)
  if (request.origin === adminOrigin) return true
  return isLoopbackHost(request.hostname)
    && isLoopbackHost(admin.hostname)
    && request.protocol === admin.protocol
    && request.port === admin.port
}

function createCreatorSkillDownloadFetch(
  getAdminAccessToken?: () => string | Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const adminUrl = getAdminUrl()
  const adminOrigin = adminUrl ? new URL(adminUrl).origin : null

  const authenticatedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const headers = new Headers(init?.headers)
    if (adminOrigin) {
      const requestUrl = typeof input === 'string' || input instanceof URL
        ? input.toString()
        : input.url
      if (shouldAttachAdminAuth(requestUrl, adminOrigin)) {
        let accessToken = await getAdminAccessToken?.()
        if (!accessToken) {
          const credentialManager = new CredentialManager()
          const tokens = await credentialManager.getAdminTokens()
          accessToken = tokens?.accessToken ?? null
        }
        if (accessToken) {
          headers.set('Authorization', `Bearer ${accessToken}`)
        }
      }
    }

    return fetchImpl(input, {
      ...init,
      headers,
    })
  }

  const preconnect = fetchImpl.preconnect
  return Object.assign(
    authenticatedFetch,
    typeof preconnect === 'function'
      ? { preconnect: preconnect.bind(fetchImpl) }
      : {},
  ) as typeof fetch
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let existingAncestor = resolve(path)
  const missingSegments: string[] = []
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) throw new Error('Path has no existing ancestor')
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }
  return resolve(await realpath(existingAncestor), ...missingSegments)
}

async function deriveSessionWorkingDirectory(
  deps: HandlerDeps,
  workspace: { id: string; rootPath: string },
  sessionId: string,
): Promise<string | undefined> {
  const session = await deps.sessionManager.getSession(sessionId)
  if (!session || session.workspaceId !== workspace.id) {
    throw Object.assign(new Error('Session does not belong to the current workspace'), {
      code: 'workspace_context_mismatch',
    })
  }
  if (!session.workingDirectory) return undefined

  try {
    const workspaceRoot = await realpath(resolve(workspace.rootPath))
    const workingDirectory = await canonicalizePotentialPath(session.workingDirectory)
    if (
      workingDirectory !== workspaceRoot
      && !workingDirectory.startsWith(`${workspaceRoot}${sep}`)
    ) {
      throw new Error('Session working directory is outside the workspace')
    }
    if (existsSync(workingDirectory) && !(await stat(workingDirectory)).isDirectory()) {
      throw new Error('Session working directory is not a directory')
    }
    return workingDirectory
  } catch {
    throw Object.assign(new Error('Session working directory is not workspace-scoped'), {
      code: 'workspace_context_mismatch',
    })
  }
}

export function assertCreatorSkillCommitAllowed(check: {
  success?: boolean
  creatorSkillArtifacts?: boolean
  status?: 'active' | 'revoked' | 'archived'
  errorCode?: string
}): void {
  if (!check.success || check.creatorSkillArtifacts !== true) {
    throw Object.assign(new Error('Creator Skill distribution is disabled'), {
      code: check.errorCode ?? 'creator_skill_feature_disabled',
    })
  }
  if (check.status === 'revoked') {
    throw Object.assign(new Error('This Creator Skill version has been revoked'), {
      code: 'artifact_version_revoked',
    })
  }
  if (check.status !== 'active' && check.status !== 'archived') {
    throw Object.assign(new Error('Creator Skill safety status is unavailable'), {
      code: 'artifact_not_published',
    })
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_UNFILTERED,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
  RPC_CHANNELS.skills.LIST_MANAGED,
  RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT,
  RPC_CHANNELS.creatorSkills.GET_TARGET,
  RPC_CHANNELS.creatorSkills.INSTALL,
  RPC_CHANNELS.creatorSkills.CANCEL,
  RPC_CHANNELS.creatorSkills.UNINSTALL,
  RPC_CHANNELS.creatorSkills.LIST_BACKUPS,
  RPC_CHANNELS.creatorSkills.DELETE_BACKUPS,
  RPC_CHANNELS.creatorSkills.UPDATE_SAFETY_STATUS,
  RPC_CHANNELS.creatorSkills.IGNORE_VERSION,
] as const

/** Stable business-RPC error for an uncommitted (null) runtime fence. */
export const SKILLS_PRODUCT_SPACE_CONTEXT_REQUIRED = 'PRODUCT_SPACE_CONTEXT_REQUIRED'

/**
 * Every Skills entry derives its scope from the trusted Admin session and
 * the committed ProductSpace fence — never from renderer arguments. Without
 * a trusted account or a committed fence bound to it, the Skills surface is
 * closed: the same local Workspace can be entered from different
 * ProductSpaces, so enumerating its files without the fence would leak one
 * space's skill capabilities into another.
 */
async function requireTrustedSkillsScope(): Promise<{
  accountId: string
  productSpaceId: string
}> {
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  if (!trustedAccountId) {
    throw Object.assign(new Error('No trusted Admin session is available'), {
      code: SKILLS_PRODUCT_SPACE_CONTEXT_REQUIRED,
    })
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw Object.assign(new Error('No committed ProductSpace is active for this account'), {
      code: SKILLS_PRODUCT_SPACE_CONTEXT_REQUIRED,
    })
  }
  // R32-3: a read_only-restricted space starts no Skill work.
  if (isRuntimeProductSpaceRestricted(activeProductSpaceId)) {
    throw Object.assign(new Error('The ProductSpace is restricted to read-only access'), {
      code: SKILLS_PRODUCT_SPACE_CONTEXT_REQUIRED,
    })
  }
  return { accountId: trustedAccountId, productSpaceId: activeProductSpaceId }
}

/**
 * The offline read-only view may read installed skills (they are part of the
 * restored history surface) but every mutation is refused: installs and
 * deletes must be re-validated against a fresh online membership first.
 */
function assertSkillsWritable(): void {
  if (isRuntimeOfflineReadOnly()) {
    throw Object.assign(new Error('The offline read-only view cannot modify skills'), {
      code: 'OFFLINE_READ_ONLY',
    })
  }
}

async function assertOriginalNativeSkillScope(scope: {accountId: string; productSpaceId: string}, generation: number) {
  const current = await requireTrustedSkillsScope()
  if (current.accountId !== scope.accountId || current.productSpaceId !== scope.productSpaceId || getRuntimeFenceGeneration() !== generation) {
    throw Object.assign(new Error('Original Skill scope changed before native mutation'), {code: 'workspace_context_mismatch'})
  }
  assertSkillsWritable()
}

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  setManagedSkillsRoot(deps.managedSkillsRoot ?? null)
  const recoveryByWorkspaceRoot = new Map<string, Promise<void>>()
  const ensureRecovered = (workspaceRoot: string): Promise<void> => {
    const existing = recoveryByWorkspaceRoot.get(workspaceRoot)
    if (existing) return existing
    const recovery = recoverCreatorSkillOperations(workspaceRoot).then(async () => {
      await recoverNativeSkillInstallationEvidence(workspaceRoot).catch(() => {})
      await recoverCanonicalSkillOperations(workspaceRoot)
      for (const root of await listCanonicalSkillRoots(workspaceRoot)) {
        await recoverNativeSkillInstallationEvidence(root).catch(() => {})
      }
      return import('@polo-ai/shared/skills').then(({ invalidateSkillsCache }) => {
        invalidateSkillsCache()
      })
    }).catch(error => {
      recoveryByWorkspaceRoot.delete(workspaceRoot)
      deps.platform.logger?.error(
        `CREATOR_SKILLS_RECOVERY: Failed for workspace ${workspaceRoot}:`,
        error,
      )
      throw error
    })
    recoveryByWorkspaceRoot.set(workspaceRoot, recovery)
    return recovery
  }
  // Some embedded/test hosts provide a deliberately narrow SessionManager
  // facade. Recover known workspaces eagerly when enumeration is available;
  // every handler still calls ensureRecovered before touching a workspace.
  for (const workspace of deps.sessionManager.getWorkspaces?.() ?? []) {
    void ensureRecovered(workspace.rootPath).catch(() => {})
  }

  const loadSkillsWithCreatorState = async (
    workspaceRoot: string,
    workingDirectory?: string,
    // The management inventory lists disabled skills too (it is the only place
    // they can be re-enabled from), so it skips the composition filter.
    unfiltered = false,
  ): Promise<LoadedSkill[]> => {
    const [, ledger] = await Promise.all([
      import('@polo-ai/shared/skills'),
      readCreatorSkillsLedger(workspaceRoot),
    ])
    const installedBySlug = new Map(ledger.installed
      .filter((item): item is import('@polo-ai/shared/creator-skills').LegacyInstalledCreatorSkill => typeof item.organizationId === 'string' && item.canonicalSource === undefined)
      .map(item => [item.slug, item]))
    const scope = { ...await requireTrustedSkillsScope(), fenceGeneration: getRuntimeFenceGeneration() }
    // Same composition rule as SessionManager/watcher discovery: personal
    // legacy tiers only in an active personal space, bundled app Skills in
    // every active space, canonical on top.
    const skills = await (unfiltered ? discoverProductSpaceSkills : loadProductSpaceSkills)(workspaceRoot, scope, workingDirectory)
    await assertOriginalNativeSkillScope(scope, scope.fenceGeneration)
    return skills.map(skill => {
      const installation = installedBySlug.get(skill.slug)
      // Legacy ledger metadata belongs to user-owned workspace copies only —
      // never to a canonical row that happens to share its slug.
      return installation && skill.source === 'workspace' && !skill.canonicalInstallation
        ? { ...skill, creatorInstallation: installation }
        : skill
    })
  }

  const broadcastSkillsChanged = async (workspaceId: string, workspaceRoot: string) => {
    const { invalidateSkillsCache } = await import('@polo-ai/shared/skills')
    invalidateSkillsCache()
    const skills = await loadSkillsWithCreatorState(workspaceRoot)
    pushTyped(
      server,
      RPC_CHANNELS.skills.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
      skills,
    )
  }

  server.handle(RPC_CHANNELS.productSpace.INSTALL_SKILL, async (ctx, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return workspaceMutationError('invalid', 'VALIDATION_ERROR')
    const input = raw as Record<string, unknown>
    if (typeof input.workspaceId !== 'string' || !CatalogEntryIdSchema.safeParse(input.catalogEntryId).success
      || !CreatorSkillOperationIdSchema.safeParse(input.operationId).success
      || (input.replaceExisting !== undefined && typeof input.replaceExisting !== 'boolean')
      || (input.backupLocalChanges !== undefined && typeof input.backupLocalChanges !== 'boolean')
      || Object.keys(input).some(key => !['workspaceId', 'catalogEntryId', 'operationId', 'replaceExisting', 'backupLocalChanges'].includes(key))) {
      return workspaceMutationError('invalid', 'VALIDATION_ERROR')
    }
    const operationId = input.operationId as string
    const workspace = getBoundWorkspace(ctx, input.workspaceId, deps)
    if (!workspace || !await hasWorkspaceSkillWriteAccess(workspace.rootPath)) return workspaceMutationError(operationId, 'workspace_context_mismatch')
    assertSkillsWritable()
    await ensureRecovered(workspace.rootPath)
    const scope = { ...await requireTrustedSkillsScope(), fenceGeneration: getRuntimeFenceGeneration() }
    const resolved = await resolveCanonicalSkill(scope, { catalogEntryId: input.catalogEntryId as string })
    await resolved.assertCurrent()
    const source = canonicalSkillSourceFromLaunch(scope, resolved)
    const launch = resolved.launch
    if (launch.subject.kind !== 'artifact_instance' || launch.delivery.kind !== 'bundle') return workspaceMutationError(operationId, 'VALIDATION_ERROR')
    const subject = launch.subject, delivery = launch.delivery
    const controller = new AbortController()
    const abort = () => controller.abort()
    ctx.signal?.addEventListener('abort', abort, { once: true })
    if (ctx.signal?.aborted) controller.abort()
    const root = canonicalSkillRoot(workspace.rootPath, source)
    const execution = registerSkillOperationExecution({ ...scope, workspaceId: workspace.id, workspaceRoot: root,
      operationOwnerId: ctx.clientId, operationId, slug: source.subjectId, version: launch.subject.version,
      subject: { ...launch.subject, artifactType: 'skill' }, cancelDownload: abort, executionId: `skill-op:${canonicalSkillIdentity(source)}:${operationId}` })
    let result: Awaited<ReturnType<typeof installCanonicalSkill>>
    try {
      result = await installCanonicalSkill(workspace.rootPath, {
        workspaceId: workspace.id, operationId, source, version: launch.subject.version,
        checksum: launch.delivery.checksum, sizeBytes: launch.delivery.sizeBytes, downloadUrl: launch.delivery.downloadUrl, expiresAt: launch.expiresAt,
        replaceExisting: input.replaceExisting as boolean | undefined, backupLocalChanges: input.backupLocalChanges as boolean | undefined,
      }, {
        fetch: resolved.fetch, signal: controller.signal, operationOwnerId: ctx.clientId,
        onValidated: async (isolatedRoot, slug) => {
          await resolved.assertCurrent()
          const intent = await prepareNativeCanonicalSkillInstall(source, isolatedRoot, slug, launch.subject.kind === 'artifact_instance' ? launch.subject.version : '', launch.delivery.kind === 'bundle' ? launch.delivery.checksum : '').catch(() => null)
          await resolved.assertCurrent()
          return { ...(intent ? { nativeInstallationAdmissionId: intent.admission.admissionId } : {}), onNativeCommitted: result => finishNativeSkillInstallation(intent, result) }
        },
        assertCommitAllowed: async () => {
          await resolved.assertCurrent()
          if (controller.signal.aborted) throw new Error('Canonical Skill installation cancelled')
          // Re-resolve the current version immediately before native commit.
          const current = await resolveCanonicalSkill(scope, { subjectId: source.subjectId })
          const next = canonicalSkillSourceFromLaunch(scope, current)
          if (next.versionId !== source.versionId || next.subjectKind !== source.subjectKind || current.launch.subject.kind !== 'artifact_instance'
            || current.launch.subject.version !== subject.version || current.launch.delivery.kind !== 'bundle'
            || current.launch.delivery.checksum.replace(/^sha256:/, '').toLowerCase() !== delivery.checksum.replace(/^sha256:/, '').toLowerCase()) throw new Error('Canonical Skill current version changed')
          await current.assertCurrent(); await resolved.assertCurrent()
        },
      })
    } finally { execution.settle(); ctx.signal?.removeEventListener('abort', abort) }
    // Original R11 lifecycle: refresh/transport starts after native execution
    // settlement, so session cleanup cannot wait on its own running installer.
    if (result.success) void flushNativeSkillInstallationEvidence().catch(() => {})
    return result
  })

  // Local removal is an exact native ownership operation, not a new grant.
  const uninstallCanonical = async (ctx: RequestContext, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return workspaceMutationError('invalid', 'VALIDATION_ERROR')
    const input = raw as Record<string, unknown>
    if (typeof input.workspaceId !== 'string' || typeof input.subjectId !== 'string'
      || typeof input.versionId !== 'string'
      || !['personal_artifact', 'enterprise_instance'].includes(String(input.subjectKind))
      || !CreatorSkillOperationIdSchema.safeParse(input.operationId).success
      || Object.keys(input).some(key => !['workspaceId', 'subjectKind', 'subjectId', 'versionId', 'operationId'].includes(key))) return workspaceMutationError('invalid', 'VALIDATION_ERROR')
    const scope = await requireTrustedSkillsScope(), generation = getRuntimeFenceGeneration()
    const workspace = getBoundWorkspace(ctx, input.workspaceId, deps), operationId = input.operationId as string
    if (!workspace || !await hasWorkspaceSkillWriteAccess(workspace.rootPath)) return workspaceMutationError(operationId, 'workspace_context_mismatch')
    assertSkillsWritable()
    await ensureRecovered(workspace.rootPath)
    const rows = await readCanonicalSkillInstallations(workspace.rootPath, scope, { nativeMutationFacts: true })
    const row = rows.find(row => row.installation.canonicalSource.subjectKind === input.subjectKind && row.installation.canonicalSource.subjectId === input.subjectId && row.installation.canonicalSource.versionId === input.versionId)
    if (!row) return workspaceMutationError(operationId, 'workspace_context_mismatch')
    await assertOriginalNativeSkillScope(scope, generation)
    let intent: Awaited<ReturnType<typeof prepareNativeSkillUninstall>> = null
    const execution = registerSkillOperationExecution({ ...scope, workspaceId: workspace.id, workspaceRoot: row.root,
      operationOwnerId: ctx.clientId, operationId, slug: row.installation.slug, version: row.installation.version,
      executionId: `skill-op:${canonicalSkillIdentity(row.installation.canonicalSource)}:${operationId}`,
      subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: row.installation.canonicalSource.subjectId,
        versionId: row.installation.canonicalSource.versionId, version: row.installation.version } })
    let result: Awaited<ReturnType<typeof uninstallCreatorSkill>>
    try { result = await uninstallCreatorSkill({ workspaceRoot: row.root, workspaceId: workspace.id, operationId, slug: row.installation.slug }, {
      beforeNativeMutation: async installed => {
        await assertOriginalNativeSkillScope(scope, generation)
        if (installed?.canonicalSource?.accountId !== scope.accountId || installed.canonicalSource.productSpaceId !== scope.productSpaceId || installed.canonicalSource.subjectId !== input.subjectId || installed.canonicalSource.subjectKind !== input.subjectKind || installed.canonicalSource.versionId !== input.versionId) throw new Error('Canonical Skill native owner changed')
        intent = await prepareNativeSkillUninstall(row.root, row.installation.slug).catch(() => null)
        await assertOriginalNativeSkillScope(scope, generation)
      },
      onNativeCommitted: result => finishNativeSkillInstallation(intent, result),
    }) } finally { execution.settle() }
    if (result.success) void flushNativeSkillInstallationEvidence().catch(() => {})
    return result
  }
  server.handle(RPC_CHANNELS.productSpace.UNINSTALL_SKILL, uninstallCanonical)

  // Shared read path for the composer channel (filtered, SM-09) and the
  // management-workbench channel (unfiltered): a disabled skill must stay
  // listed in the management view or it could never be re-enabled (B1).
  const readWorkspaceSkills = async (ctx: RequestContext, workspaceId: string, unfiltered: boolean): Promise<LoadedSkill[]> => {
    await requireTrustedSkillsScope()
    if (isRuntimeOfflineReadOnly()) return [] // No fresh permission; restored UI history remains separate.
    const workspace = getBoundWorkspace(ctx, workspaceId, deps)
    if (!workspace) return []
    await ensureRecovered(workspace.rootPath)
    const activeSessionId = getClientActiveSession(ctx.clientId, workspace.id)
    // A stale binding (e.g. active session deleted from another code path)
    // must not take down the whole workbench; the working directory is only a
    // discovery enhancement (same tolerance as the GET_FILES path below).
    const effectiveWorkingDir = activeSessionId
      ? await deriveSessionWorkingDirectory(deps, workspace, activeSessionId).catch(() => undefined) : undefined
    const skills = await loadSkillsWithCreatorState(workspace.rootPath, effectiveWorkingDir, unfiltered)
    deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length}${unfiltered ? ' unfiltered' : ''} skills from ${workspace.rootPath}`)
    return skills
  }

  // Get all skills for a workspace (and optionally project-level skills from workingDirectory)
  server.handle(RPC_CHANNELS.skills.GET, async (_ctx, workspaceId: string, _workingDirectory?: string) => {
    return readWorkspaceSkills(_ctx, workspaceId, false)
  })

  // Same discovery without the enablement filter, for the management list only.
  server.handle(RPC_CHANNELS.skills.GET_UNFILTERED, async (_ctx, workspaceId: string) => {
    return readWorkspaceSkills(_ctx, workspaceId, true)
  })

  // Get files in a skill directory
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (_ctx, workspaceId: string, skillSlug: string) => {
    await requireTrustedSkillsScope()
    const input = DeleteSkillRpcInputSchema.safeParse({workspaceId,skillSlug})
    if (!input.success) return []
    const workspace = getBoundWorkspace(_ctx, input.data.workspaceId, deps)
    if (!workspace) return []
    const activeSessionId = getClientActiveSession(_ctx.clientId, workspace.id)
    // Same stale-binding tolerance as readWorkspaceSkills above.
    const workingDirectory = activeSessionId ? await deriveSessionWorkingDirectory(deps,workspace,activeSessionId).catch(() => undefined) : undefined
    const skill = (await loadSkillsWithCreatorState(workspace.rootPath,workingDirectory)).find(row => row.slug === skillSlug)
    if (!skill) return []
    const skillDir = skill.path

    function scanDirectory(dirPath: string): SkillFile[] {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter(entry => !entry.name.startsWith('.') && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
          .map(entry => {
            const fullPath = join(dirPath, entry.name)
            if (entry.isDirectory()) {
              return {
                name: entry.name,
                type: 'directory' as const,
                children: scanDirectory(fullPath),
              }
            } else {
              const stats = statSync(fullPath)
              return {
                name: entry.name,
                type: 'file' as const,
                size: stats.size,
              }
            }
          })
          .sort((a, b) => {
            // Directories first, then files
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      } catch (err) {
        deps.platform.logger?.error(`SKILLS_GET_FILES: Error scanning ${dirPath}:`, err)
        return []
      }
    }

    return scanDirectory(skillDir)
  })

  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (ctx, rawInput: unknown) => {
    const input = DeleteSkillRpcInputSchema.safeParse(rawInput)
    if (!input.success) {
      throw Object.assign(new Error('VALIDATION_ERROR'), {
        code: 'VALIDATION_ERROR',
      })
    }
    await requireTrustedSkillsScope()
    assertSkillsWritable()
    const { workspaceId, skillSlug } = input.data
    const workspace = getBoundWorkspace(ctx, workspaceId, deps)
    if (!workspace) throw Object.assign(new Error('Workspace context mismatch'), {
      code: 'workspace_context_mismatch',
    })
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      throw Object.assign(new Error('Workspace is read-only'), {
        code: 'workspace_read_only',
      })
    }
    // Bundled app Skills ship inside the client and cannot be uninstalled —
    // but only while the user has no own copy: a same-slug workspace Skill is
    // a regular user asset whose deletion must not be vetoed by the bundled
    // directory it shadows (deleting it leaves the bundled original in place).
    const { loadBundledSkill, skillExists } = await import('@polo-ai/shared/skills')
    if (!skillExists(workspace.rootPath, skillSlug) && loadBundledSkill(skillSlug)) return false
    if (skillSlug.startsWith('canonical-')) {
      const scope = await requireTrustedSkillsScope()
      const original = (await readCanonicalSkillInstallations(workspace.rootPath, scope, { nativeMutationFacts: true }))
        .find(row => `canonical-${canonicalSkillIdentity(row.installation.canonicalSource)}` === skillSlug)
      if (!original) return false
      const result = await uninstallCanonical(ctx, { workspaceId, subjectKind: original.installation.canonicalSource.subjectKind, subjectId: original.installation.canonicalSource.subjectId, versionId: original.installation.canonicalSource.versionId, operationId: crypto.randomUUID() })
      // Supply only the exact native selector, never renderer account/grant.
      return result.success
    }
    await ensureRecovered(workspace.rootPath)

    const ledger = await readCreatorSkillsLedger(workspace.rootPath)
    const managed = ledger.installed.some(item => item.slug === skillSlug)
    const pendingDetach = !managed
      && await hasPendingCreatorSkillForceDelete(workspace.rootPath, skillSlug)
    let detached = false
    let forceDeleteCredential: string | undefined
    if (managed || pendingDetach) {
      // R33-2: the in-flight uninstall is a cancellable ProductSpace
      // execution under the trusted scope. One operationId binds the
      // registration to the cancellation controller.
      const deleteScope = await requireTrustedSkillsScope()
      const deleteGeneration = getRuntimeFenceGeneration()
      const deleteOperationId = crypto.randomUUID()
      const deleteOperation = registerSkillOperationExecution({
        accountId: deleteScope.accountId,
        productSpaceId: deleteScope.productSpaceId,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        operationOwnerId: ctx.clientId,
        operationId: deleteOperationId,
        slug: skillSlug,
      })
      let result: Awaited<ReturnType<typeof uninstallCreatorSkill>>
      let installationIntent: Awaited<ReturnType<typeof prepareNativeSkillUninstall>> = null
      try {
        result = await uninstallCreatorSkill({
          workspaceRoot: workspace.rootPath,
          workspaceId: workspace.id,
          operationId: deleteOperationId,
          slug: skillSlug,
        }, {
          beforeNativeMutation: async () => {
            installationIntent = await prepareNativeSkillUninstall(workspace.rootPath,skillSlug).catch(() => null)
            await assertOriginalNativeSkillScope(deleteScope,deleteGeneration)
          },
          onNativeCommitted: result => finishNativeSkillInstallation(installationIntent,result),
          onError: error => deps.platform.logger?.error(
            'CREATOR_SKILLS_UNINSTALL: Server-side failure:',
            error,
          ),
        })
      } finally {
        deleteOperation.settle()
      }
      if (!result.success) throw Object.assign(new Error(result.message), {
        code: result.errorCode,
      })
      void flushNativeSkillInstallationEvidence().catch(() => {})
      detached = result.detached === true
      forceDeleteCredential = result.forceDeleteCredential
    } else {
      const { deleteSkill } = await import('@polo-ai/shared/skills')
      deleteSkill(workspace.rootPath, skillSlug)
    }
    await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
    return {
      managed: managed || pendingDetach,
      detached,
      ...(forceDeleteCredential ? { forceDeleteCredential } : {}),
    }
  })

  // ── Managed local-skill enablement (POO-106 S1) ─────────────────────────
  // Bundled skills never appear here as toggle targets: they are always
  // available (SM-18a/d) and user entries shadowing them are refused too (K1).

  /** Inventory rows plus the per-entry enablement facts the UI renders. */
  const buildManagedSkillInventory = async (
    workspaceRoot: string,
    workingDirectory?: string,
  ): Promise<{ items: ManagedSkillStatus[]; revision: number }> => {
    const accountId = (await requireTrustedSkillsScope()).accountId
    const skills = await loadSkillsWithCreatorState(workspaceRoot, workingDirectory, true)
    const disabledSlugs = readDisabledManagedSkillSlugs(accountId, workspaceRoot)
    const { loadBundledSkill } = await import('@polo-ai/shared/skills')
    const items = skills.map((skill): ManagedSkillStatus => {
      if (skill.source === 'bundled') {
        return { slug: skill.slug, source: skill.source, enabled: true, toggleable: false, managed: false, shadowedBuiltin: false }
      }
      const managed = isCanonicalManagedSkill(skill)
      const shadowedBuiltin = Boolean(loadBundledSkill(skill.slug))
      const toggleable = !managed && !shadowedBuiltin
      return {
        slug: skill.slug,
        source: skill.source,
        enabled: toggleable ? !disabledSlugs.has(skill.slug) : true,
        toggleable,
        managed,
        shadowedBuiltin,
      }
    })
    return { items, revision: readManagedSkillEnablementDocument(accountId, workspaceRoot).revision }
  }

  server.handle(RPC_CHANNELS.skills.LIST_MANAGED, async (ctx, rawInput: unknown) => {
    const input = ListManagedSkillsRequestSchema.safeParse(rawInput)
    if (!input.success) return managedSkillEnablementError('VALIDATION_ERROR')
    await requireTrustedSkillsScope()
    if (isRuntimeOfflineReadOnly()) return { ok: true as const, workspaceId: input.data.workspaceId, revision: 0, items: [] }
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    // A remote (or unknown) workspace has no local enablement scope: the UI
    // treats missing rows as non-toggleable, which is exactly the K3 stance.
    if (!workspace || workspace.remoteServer) {
      return { ok: true as const, workspaceId: input.data.workspaceId, revision: 0, items: [] }
    }
    await ensureRecovered(workspace.rootPath)
    const activeSessionId = getClientActiveSession(ctx.clientId, workspace.id)
    const workingDirectory = activeSessionId
      ? await deriveSessionWorkingDirectory(deps, workspace, activeSessionId).catch(() => undefined)
      : undefined
    const { items, revision } = await buildManagedSkillInventory(workspace.rootPath, workingDirectory)
    return { ok: true as const, workspaceId: workspace.id, revision, items }
  })

  server.handle(RPC_CHANNELS.skills.SET_MANAGED_ENABLEMENT, async (ctx, rawInput: unknown) => {
    const input = SetManagedSkillEnablementRequestSchema.safeParse(rawInput)
    if (!input.success) return managedSkillEnablementError('VALIDATION_ERROR')
    await requireTrustedSkillsScope()
    // The offline refusal is part of the declared error-code contract, so it is
    // reported as a structured result instead of a thrown transport error (N1).
    try {
      assertSkillsWritable()
    } catch (error) {
      if ((error as { code?: unknown }).code === 'OFFLINE_READ_ONLY') {
        return managedSkillEnablementError('OFFLINE_READ_ONLY')
      }
      throw error
    }
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace || workspace.remoteServer) return managedSkillEnablementError('workspace_context_mismatch')
    await ensureRecovered(workspace.rootPath)
    const { accountId } = await requireTrustedSkillsScope()
    const inventory = await buildManagedSkillInventory(workspace.rootPath)
    const current = inventory.items.find(item => item.slug === input.data.slug)
    if (!current) {
      // A bundled-only slug has no user-tier row at all; name the refusal
      // precisely instead of a generic not-found (SM-18d defense in depth).
      const { loadBundledSkill } = await import('@polo-ai/shared/skills')
      if (loadBundledSkill(input.data.slug)) return managedSkillEnablementError('bundled_skill_not_disableable')
      return managedSkillEnablementError('skill_not_found')
    }
    // Bundled entries never reach this inventory as user-tier rows, so the
    // refusal below covers canonical/creator-managed and shadowedBuiltin (K8).
    if (current.source !== input.data.source) {
      // A forged user-tier write for a bundled-only slug lands here: name the
      // refusal precisely instead of a generic not-found (SM-18d).
      const { loadBundledSkill } = await import('@polo-ai/shared/skills')
      if (loadBundledSkill(input.data.slug)) return managedSkillEnablementError('bundled_skill_not_disableable')
      return managedSkillEnablementError('skill_not_found')
    }
    if (!current.toggleable) {
      return current.shadowedBuiltin
        ? managedSkillEnablementError('shadowed_builtin_not_toggleable')
        : managedSkillEnablementError('managed_skill_not_toggleable')
    }
    const result = writeManagedSkillEnablement({
      accountId,
      workspaceRoot: workspace.rootPath,
      slug: input.data.slug,
      source: input.data.source,
      enabled: input.data.enabled,
      expectedRevision: input.data.expectedRevision,
    })
    if (!result.ok) return managedSkillEnablementError('revision_conflict', { revision: result.revision })
    await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    deps.platform.logger?.info(`MANAGED_SKILLS: ${input.data.slug} ${input.data.enabled ? 'enabled' : 'disabled'} (revision ${result.revision})`)
    return { ok: true as const, slug: input.data.slug, enabled: input.data.enabled, revision: result.revision }
  })

  server.handle(RPC_CHANNELS.creatorSkills.GET_TARGET, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillTargetRpcInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { success: false, errorCode: 'VALIDATION_ERROR' }
    }
    await requireTrustedSkillsScope()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) return { success: false, errorCode: 'workspace_context_mismatch' }
    return {
      success: true,
      workspaceId: workspace.id,
      name: workspace.name,
      path: workspace.rootPath,
      writable: await hasWorkspaceSkillWriteAccess(workspace.rootPath),
    }
  })

  server.handle(RPC_CHANNELS.creatorSkills.INSTALL, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillInstallRpcInputSchema.safeParse(rawInput)
    if (!input.success) {
      return {
        success: false,
        operationId: 'invalid',
        errorCode: 'VALIDATION_ERROR',
        stage: 'prepare',
        message: 'Creator Skill install request is invalid',
        diagnostic: JSON.stringify({ errorCode: 'VALIDATION_ERROR', stage: 'prepare' }),
        retryable: false,
      }
    }
    await requireTrustedSkillsScope()
    assertSkillsWritable()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) {
      return workspaceMutationError(input.data.operationId, 'workspace_context_mismatch')
    }
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      return workspaceMutationError(input.data.operationId, 'workspace_read_only')
    }
    await ensureRecovered(workspace.rootPath)
    const activeSessionId = getClientActiveSession(ctx.clientId, workspace.id)
    if (!activeSessionId) {
      return workspaceMutationError(input.data.operationId, 'workspace_context_mismatch')
    }
    let workingDirectory: string | undefined
    try {
      workingDirectory = await deriveSessionWorkingDirectory(
        deps,
        workspace,
        activeSessionId,
      )
    } catch {
      return workspaceMutationError(input.data.operationId, 'workspace_context_mismatch')
    }
    // R33-2: the in-flight install is a cancellable ProductSpace execution.
    const skillScope = await requireTrustedSkillsScope()
    const installationFenceGeneration = getRuntimeFenceGeneration()
    // Legacy organization grants have no authoritative enterprise-instance
    // identity. Such installations keep their existing native behavior and
    // remain unknown in support inventory; never guess from the active space.
    const installationIntent = await prepareNativeSkillInstall(skillScope,workspace.rootPath,input.data.grant).catch(() => null)
    const installationScopeCurrent = await requireTrustedSkillsScope()
    if (installationScopeCurrent.accountId !== skillScope.accountId || installationScopeCurrent.productSpaceId !== skillScope.productSpaceId
      || getRuntimeFenceGeneration() !== installationFenceGeneration) return workspaceMutationError(input.data.operationId,'workspace_context_mismatch')
    const skillOperation = registerSkillOperationExecution({
      accountId: skillScope.accountId,
      productSpaceId: skillScope.productSpaceId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      operationOwnerId: ctx.clientId,
      operationId: input.data.operationId,
      slug: input.data.grant.slug,
      version: input.data.grant.version,
    })
    let result: Awaited<ReturnType<typeof installCreatorSkill>>
    try {
      result = await installCreatorSkill(workspace.rootPath, {
        ...input.data,
        ...(workingDirectory ? { workingDirectory } : {}),
      }, {
        ...(installationIntent ? { nativeInstallationAdmissionId: installationIntent.admission.admissionId } : {}),
        onNativeCommitted: result => finishNativeSkillInstallation(installationIntent,result),
        operationOwnerId: ctx.clientId,
        fetch: createCreatorSkillDownloadFetch(
          deps.platform.getAdminAccessToken,
        ),
        onProgress: progress => pushTyped(
          server,
          RPC_CHANNELS.creatorSkills.PROGRESS,
          { to: 'client', clientId: ctx.clientId },
          progress,
        ),
        assertCommitAllowed: async identity => {
          const check = await server.invokeClient(
            ctx.clientId,
            CLIENT_CREATOR_SKILL_COMMIT_CHECK,
            identity,
          ) as {
            success?: boolean
            creatorSkillArtifacts?: boolean
            status?: 'active' | 'revoked' | 'archived'
            errorCode?: string
          }
          assertCreatorSkillCommitAllowed(check)
        },
        onError: error => deps.platform.logger?.error(
          'CREATOR_SKILLS_INSTALL: Server-side failure:',
          error,
        ),
      })
    } finally {
      skillOperation.settle()
    }
    if (result.success) {
      void flushNativeSkillInstallationEvidence().catch(() => {})
      await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    }
    return result
  })

  server.handle(RPC_CHANNELS.creatorSkills.CANCEL, async (ctx, operationId: unknown) => {
    if (!CreatorSkillOperationIdSchema.safeParse(operationId).success) {
      return { success: false }
    }
    await requireTrustedSkillsScope()
    const workspaceId = currentWorkspaceId(ctx, deps)
    const workspace = workspaceId
      ? getBoundWorkspace(ctx, workspaceId, deps)
      : null
    return {
      success: workspace
        ? await cancelCreatorSkillOperation(
            workspace.rootPath,
            ctx.clientId,
            operationId as string,
          )
        : false,
    }
  })

  server.handle(RPC_CHANNELS.creatorSkills.UNINSTALL, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillUninstallRpcInputSchema.safeParse(rawInput)
    if (!input.success) {
      return {
        success: false,
        operationId: 'invalid',
        errorCode: 'VALIDATION_ERROR',
        stage: 'prepare',
        message: 'Creator Skill uninstall request is invalid',
        diagnostic: JSON.stringify({ errorCode: 'VALIDATION_ERROR', stage: 'prepare' }),
        retryable: false,
      }
    }
    await requireTrustedSkillsScope()
    assertSkillsWritable()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) {
      return workspaceMutationError(input.data.operationId, 'workspace_context_mismatch')
    }
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      return workspaceMutationError(input.data.operationId, 'workspace_read_only')
    }
    await ensureRecovered(workspace.rootPath)
    // R33-2: the in-flight uninstall is a cancellable ProductSpace execution.
    const skillScope = await requireTrustedSkillsScope()
    const uninstallGeneration = getRuntimeFenceGeneration()
    let installationIntent: Awaited<ReturnType<typeof prepareNativeSkillUninstall>> = null
    const skillOperation = registerSkillOperationExecution({
      accountId: skillScope.accountId,
      productSpaceId: skillScope.productSpaceId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      operationOwnerId: ctx.clientId,
      operationId: input.data.operationId,
      slug: input.data.slug,
    })
    let result: Awaited<ReturnType<typeof uninstallCreatorSkill>>
    try {
      result = await uninstallCreatorSkill({
        workspaceRoot: workspace.rootPath,
        ...input.data,
      }, {
        beforeNativeMutation: async () => {
          installationIntent = await prepareNativeSkillUninstall(workspace.rootPath,input.data.slug).catch(() => null)
          await assertOriginalNativeSkillScope(skillScope,uninstallGeneration)
        },
        onNativeCommitted: result => finishNativeSkillInstallation(installationIntent,result),
        onError: error => deps.platform.logger?.error(
          'CREATOR_SKILLS_UNINSTALL: Server-side failure:',
          error,
        ),
      })
    } finally {
      skillOperation.settle()
    }
    if (result.success) {
      void flushNativeSkillInstallationEvidence().catch(() => {})
      await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    }
    return result
  })

  server.handle(RPC_CHANNELS.creatorSkills.LIST_BACKUPS, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillBackupRpcInputSchema.safeParse(rawInput)
    if (!input.success) return { success: false, errorCode: 'VALIDATION_ERROR' }
    await requireTrustedSkillsScope()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) return { success: false, errorCode: 'workspace_context_mismatch' }
    try {
      return {
        success: true,
        backups: await listCreatorSkillBackups(workspace.rootPath),
      }
    } catch (error) {
      return {
        success: false,
        errorCode: error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'unknown')
          : 'unknown',
      }
    }
  })

  server.handle(RPC_CHANNELS.creatorSkills.DELETE_BACKUPS, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillBackupDeleteRpcInputSchema.safeParse(rawInput)
    if (!input.success) return { success: false, errorCode: 'VALIDATION_ERROR' }
    await requireTrustedSkillsScope()
    assertSkillsWritable()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) return { success: false, errorCode: 'workspace_context_mismatch' }
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      return { success: false, errorCode: 'workspace_read_only' }
    }
    try {
      return {
        success: true,
        deleted: await deleteCreatorSkillBackups(workspace.rootPath, input.data.backup),
      }
    } catch (error) {
      return {
        success: false,
        errorCode: error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'unknown')
          : 'unknown',
      }
    }
  })

  server.handle(RPC_CHANNELS.creatorSkills.UPDATE_SAFETY_STATUS, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillStatusUpdateRpcInputSchema.safeParse(rawInput)
    if (!input.success) return { success: false, errorCode: 'VALIDATION_ERROR' }
    await requireTrustedSkillsScope()
    assertSkillsWritable()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) return { success: false, errorCode: 'workspace_context_mismatch' }
    await ensureRecovered(workspace.rootPath)
    const updated = await updateCreatorSkillInstallationMetadata({
      workspaceRoot: workspace.rootPath,
      artifactId: input.data.status.artifactId,
      version: input.data.status.version,
      archiveChecksum: input.data.status.archiveChecksum,
      changes: {
        lastKnownStatus: input.data.status.status,
        lastCheckedAt: input.data.checkedAt,
      },
    })
    if (!updated) return { success: false, errorCode: 'creator_skill_not_installed' }
    await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.creatorSkills.IGNORE_VERSION, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillIgnoreVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return { success: false, errorCode: 'VALIDATION_ERROR' }
    await requireTrustedSkillsScope()
    assertSkillsWritable()
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) return { success: false, errorCode: 'workspace_context_mismatch' }
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      return { success: false, errorCode: 'workspace_read_only' }
    }
    await ensureRecovered(workspace.rootPath)
    const updated = await updateCreatorSkillInstallationMetadata({
      workspaceRoot: workspace.rootPath,
      artifactId: input.data.artifactId,
      version: input.data.version,
      archiveChecksum: input.data.archiveChecksum,
      changes: {
        ignoredVersion: input.data.ignoredVersion,
      },
    })
    if (!updated) return { success: false, errorCode: 'creator_skill_not_installed' }
    await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    return { success: true }
  })

  const resolveVisibleSkill = async (ctx: RequestContext, workspaceId: string, skillSlug: string) => {
    await requireTrustedSkillsScope()
    const input = DeleteSkillRpcInputSchema.safeParse({workspaceId,skillSlug})
    const workspace = input.success ? getBoundWorkspace(ctx,input.data.workspaceId,deps) : null
    if (!workspace) throw new Error('Skill workspace context is unavailable')
    if (workspace.remoteServer) throw new Error('Host open is not available for remote workspaces')
    const activeSessionId = getClientActiveSession(ctx.clientId,workspace.id)
    const workingDirectory = activeSessionId ? await deriveSessionWorkingDirectory(deps,workspace,activeSessionId) : undefined
    const skill = (await loadSkillsWithCreatorState(workspace.rootPath,workingDirectory)).find(row => row.slug === skillSlug)
    if (!skill) throw new Error('Skill is unavailable in the current ProductSpace')
    return skill
  }
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (ctx, workspaceId: string, skillSlug: string) => {
    const skill = await resolveVisibleSkill(ctx,workspaceId,skillSlug)
    if (skill.canonicalInstallation) throw new Error('Managed Skill instructions are read-only')
    if (skill.source === 'bundled') throw new Error('Bundled Skill instructions are read-only')
    await deps.platform.openPath?.(join(skill.path,'SKILL.md'))
  })
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (ctx, workspaceId: string, skillSlug: string) => {
    const skill = await resolveVisibleSkill(ctx,workspaceId,skillSlug)
    await deps.platform.showItemInFolder?.(skill.path)
  })
}
