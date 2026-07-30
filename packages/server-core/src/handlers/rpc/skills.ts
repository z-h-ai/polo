import { join } from 'path'
import { constants as fsConstants, existsSync, readdirSync, statSync } from 'fs'
import { access } from 'node:fs/promises'
import { RPC_CHANNELS, type SkillFile } from '@polo-ai/shared/protocol'
import { getWorkspaceByNameOrId } from '@polo-ai/shared/config'
import {
  CLIENT_CREATOR_SKILL_COMMIT_CHECK,
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  CreatorSkillBackupRpcInputSchema,
  CreatorSkillInstallRpcInputSchema,
  CreatorSkillIgnoreVersionRpcInputSchema,
  CreatorSkillOperationIdSchema,
  CreatorSkillStatusUpdateRpcInputSchema,
  CreatorSkillTargetRpcInputSchema,
  CreatorSkillUninstallRpcInputSchema,
} from '@polo-ai/shared/creator-skills/schemas'
import {
  cancelCreatorSkillOperation,
  deleteCreatorSkillBackups,
  installCreatorSkill,
  listCreatorSkillBackups,
  recoverCreatorSkillOperations,
  uninstallCreatorSkill,
  updateCreatorSkillInstallationMetadata,
} from '@polo-ai/shared/creator-skills/installer'
import {
  readCreatorSkillsLedger,
} from '@polo-ai/shared/creator-skills/ledger'
import type { LoadedSkill } from '@polo-ai/shared/skills'

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
  if (!activeId) return null
  const activeWorkspace = getWorkspaceByNameOrId(activeId)
  const requestedWorkspace = getWorkspaceByNameOrId(requestedWorkspaceId)
  if (!activeWorkspace || !requestedWorkspace || activeWorkspace.id !== requestedWorkspace.id) {
    return null
  }
  return requestedWorkspace
}

export async function hasWorkspaceSkillWriteAccess(workspaceRoot: string): Promise<boolean> {
  const paths = [
    workspaceRoot,
    join(workspaceRoot, 'skills'),
    join(workspaceRoot, '.creator-skill-ops'),
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
    message: errorCode === 'workspace_read_only'
      ? 'The active workspace does not allow Skill changes'
      : 'The requested workspace is not the active workspace for this connection',
    diagnostic: JSON.stringify({ errorCode, stage: 'prepare' }),
    retryable: false,
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
  server.handle(RPC_CHANNELS.skills.DELETE, async (ctx, workspaceId: string, skillSlug: string) => {
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
    let detached = false
    if (managed) {
      const result = await uninstallCreatorSkill({
        workspaceRoot: workspace.rootPath,
        workspaceId: workspace.id,
        operationId: crypto.randomUUID(),
        slug: skillSlug,
      })
      if (!result.success) throw Object.assign(new Error(result.message), {
        code: result.errorCode,
      })
      detached = result.detached === true
    } else {
      const { deleteSkill } = await import('@polo-ai/shared/skills')
      deleteSkill(workspace.rootPath, skillSlug)
    }
    await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
    return { managed, detached }
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
    const result = await installCreatorSkill(workspace.rootPath, input.data, {
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
        if (!check.success || check.creatorSkillArtifacts !== true) {
          throw Object.assign(new Error('Creator Skill distribution is disabled'), {
            code: check.errorCode ?? 'creator_skill_feature_disabled',
          })
        }
        if (check.status !== 'active') {
          throw Object.assign(new Error(
            check.status === 'revoked'
              ? 'This Creator Skill version has been revoked'
              : 'This Creator Skill is archived',
          ), {
            code: check.status === 'revoked'
              ? 'artifact_version_revoked'
              : 'artifact_not_published',
          })
        }
      },
    })
    if (result.success) {
      await broadcastSkillsChanged(workspace.id, workspace.rootPath)
    }
    return result
  })

  server.handle(RPC_CHANNELS.creatorSkills.CANCEL, async (_ctx, operationId: unknown) => ({
    success: CreatorSkillOperationIdSchema.safeParse(operationId).success
      ? cancelCreatorSkillOperation(operationId as string)
      : false,
  }))

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
    return {
      success: true,
      backups: await listCreatorSkillBackups(workspace.rootPath),
    }
  })

  server.handle(RPC_CHANNELS.creatorSkills.DELETE_BACKUPS, async (ctx, rawInput: unknown) => {
    const input = CreatorSkillBackupRpcInputSchema.safeParse(rawInput)
    if (!input.success) return { success: false, errorCode: 'VALIDATION_ERROR' }
    const workspace = getBoundWorkspace(ctx, input.data.workspaceId, deps)
    if (!workspace) return { success: false, errorCode: 'workspace_context_mismatch' }
    if (!await hasWorkspaceSkillWriteAccess(workspace.rootPath)) {
      return { success: false, errorCode: 'workspace_read_only' }
    }
    return {
      success: true,
      deleted: await deleteCreatorSkillBackups(workspace.rootPath, input.data.path),
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
