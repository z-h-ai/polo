import { basename, dirname, join, resolve, sep } from 'path'
import { constants as fsConstants, existsSync, readdirSync, statSync } from 'fs'
import { access, realpath, stat } from 'node:fs/promises'
import { RPC_CHANNELS, type SkillFile } from '@polo-ai/shared/protocol'
import { getAdminUrl, getWorkspaceByNameOrId } from '@polo-ai/shared/config'
import {
  CLIENT_CREATOR_SKILL_COMMIT_CHECK,
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@polo-ai/server-core/transport'
import { CredentialManager } from '@polo-ai/shared/credentials'
import type { HandlerDeps } from '../handler-deps'
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
import type { LoadedSkill } from '@polo-ai/shared/skills'
import { getClientActiveSession } from './client-active-session'

function currentWorkspaceId(ctx: RequestContext, deps: HandlerDeps): string | null {
  if (ctx.workspaceId) return ctx.workspaceId
  if (ctx.webContentsId === null) return null
  return deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? null
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
  errorCode: 'workspace_context_mismatch' | 'workspace_read_only',
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

  return Object.assign(authenticatedFetch, {
    preconnect: fetchImpl.preconnect.bind(fetchImpl),
  }) as typeof fetch
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
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
  RPC_CHANNELS.creatorSkills.GET_TARGET,
  RPC_CHANNELS.creatorSkills.INSTALL,
  RPC_CHANNELS.creatorSkills.CANCEL,
  RPC_CHANNELS.creatorSkills.UNINSTALL,
  RPC_CHANNELS.creatorSkills.LIST_BACKUPS,
  RPC_CHANNELS.creatorSkills.DELETE_BACKUPS,
  RPC_CHANNELS.creatorSkills.UPDATE_SAFETY_STATUS,
  RPC_CHANNELS.creatorSkills.IGNORE_VERSION,
] as const

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const recoveryByWorkspaceRoot = new Map<string, Promise<void>>()
  const ensureRecovered = (workspaceRoot: string): Promise<void> => {
    const existing = recoveryByWorkspaceRoot.get(workspaceRoot)
    if (existing) return existing
    const recovery = recoverCreatorSkillOperations(workspaceRoot).then(() => {
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
  ): Promise<LoadedSkill[]> => {
    const [{ loadAllSkills }, ledger] = await Promise.all([
      import('@polo-ai/shared/skills'),
      readCreatorSkillsLedger(workspaceRoot),
    ])
    const installedBySlug = new Map(ledger.installed.map(item => [item.slug, item]))
    return loadAllSkills(workspaceRoot, workingDirectory).map(skill => {
      const installation = installedBySlug.get(skill.slug)
      return installation && skill.source === 'workspace'
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

  // Get all skills for a workspace (and optionally project-level skills from workingDirectory)
  server.handle(RPC_CHANNELS.skills.GET, async (_ctx, workspaceId: string, workingDirectory?: string) => {
    deps.platform.logger?.info(`SKILLS_GET: Loading skills for workspace: ${workspaceId}${workingDirectory ? `, workingDirectory: ${workingDirectory}` : ''}`)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger?.error(`SKILLS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    await ensureRecovered(workspace.rootPath)
    // Validate workingDirectory exists on this server — a thin client may pass
    // its local path which doesn't exist on the remote server's filesystem.
    const effectiveWorkingDir = workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined
    const skills = await loadSkillsWithCreatorState(workspace.rootPath, effectiveWorkingDir)
    deps.platform.logger?.info(`SKILLS_GET: Loaded ${skills.length} skills from ${workspace.rootPath}`)
    return skills
  })

  // Get files in a skill directory
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger?.error(`SKILLS_GET_FILES: Workspace not found: ${workspaceId}`)
      return []
    }

    const { getWorkspaceSkillsPath } = await import('@polo-ai/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillDir = join(skillsDir, skillSlug)

    function scanDirectory(dirPath: string): SkillFile[] {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter(entry => !entry.name.startsWith('.')) // Skip hidden files
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
    await ensureRecovered(workspace.rootPath)

    const ledger = await readCreatorSkillsLedger(workspace.rootPath)
    const managed = ledger.installed.some(item => item.slug === skillSlug)
    const pendingDetach = !managed
      && await hasPendingCreatorSkillForceDelete(workspace.rootPath, skillSlug)
    let detached = false
    let forceDeleteCredential: string | undefined
    if (managed || pendingDetach) {
      const result = await uninstallCreatorSkill({
        workspaceRoot: workspace.rootPath,
        workspaceId: workspace.id,
        operationId: crypto.randomUUID(),
        slug: skillSlug,
      }, {
        onError: error => deps.platform.logger?.error(
          'CREATOR_SKILLS_UNINSTALL: Server-side failure:',
          error,
        ),
      })
      if (!result.success) throw Object.assign(new Error(result.message), {
        code: result.errorCode,
      })
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

  server.handle(RPC_CHANNELS.creatorSkills.GET_TARGET, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillTargetRpcInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { success: false, errorCode: 'VALIDATION_ERROR' }
    }
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
    const result = await installCreatorSkill(workspace.rootPath, {
      ...input.data,
      ...(workingDirectory ? { workingDirectory } : {}),
    }, {
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
    if (result.success) {
      await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    }
    return result
  })

  server.handle(RPC_CHANNELS.creatorSkills.CANCEL, async (ctx, operationId: unknown) => {
    if (!CreatorSkillOperationIdSchema.safeParse(operationId).success) {
      return { success: false }
    }
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
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) {
      return workspaceMutationError(input.data.operationId, 'workspace_context_mismatch')
    }
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      return workspaceMutationError(input.data.operationId, 'workspace_read_only')
    }
    await ensureRecovered(workspace.rootPath)
    const result = await uninstallCreatorSkill({
      workspaceRoot: workspace.rootPath,
      ...input.data,
    }, {
      onError: error => deps.platform.logger?.error(
        'CREATOR_SKILLS_UNINSTALL: Server-side failure:',
        error,
      ),
    })
    if (result.success) {
      await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    }
    return result
  })

  server.handle(RPC_CHANNELS.creatorSkills.LIST_BACKUPS, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillBackupRpcInputSchema.safeParse(rawInput)
    if (!input.success) return { success: false, errorCode: 'VALIDATION_ERROR' }
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

  // Open skill SKILL.md in editor
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    if (workspace.remoteServer) throw new Error('Open in editor is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@polo-ai/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillFile = join(skillsDir, skillSlug, 'SKILL.md')
    await deps.platform.openPath?.(skillFile)
  })

  // Open skill folder in Finder/Explorer
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    if (workspace.remoteServer) throw new Error('Show in Finder is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@polo-ai/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.rootPath)
    const skillDir = join(skillsDir, skillSlug)
    await deps.platform.showItemInFolder?.(skillDir)
  })
}
