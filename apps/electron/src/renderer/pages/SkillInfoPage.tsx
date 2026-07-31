/**
 * SkillInfoPage
 *
 * Displays comprehensive skill details including metadata,
 * advisory metadata and instructions.
 * Uses the Info_ component system for consistent styling with SourceInfoPage.
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback } from 'react'
import { AlertTriangle } from 'lucide-react'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { toast } from 'sonner'
import { SkillMenu } from '@/components/app-shell/SkillMenu'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { routes, navigate } from '@/lib/navigate'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { creatorSkillConflictConfirmation } from '@/lib/creator-skill-conflicts'
import { deleteWorkspaceSkillWithModifiedConfirmation } from '@/lib/creator-skill-delete'
import {
  creatorSkillErrorDiagnostic,
  translateCreatorSkillError,
} from '@/lib/creator-skill-errors'
import { creatorSkillHasStaleSafetyStatus } from '@/lib/creator-skill-safety-display'
import { refreshCreatorSkillSafetyStatus } from '@/lib/creator-skill-safety-refresh'
import {
  creatorSkillSafetyCheckStatesAtom,
  creatorSkillSafetyIdentityKey,
} from '@/atoms/creator-skill-safety'
import {
  actionableCreatorSkillSafeVersion,
  compareStableCreatorSkillVersion,
} from '@/lib/creator-skill-version'
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Markdown,
} from '@/components/info'
import type { CreatorSkillOperationProgress, LoadedSkill } from '../../shared/types'

interface SkillInfoPageProps {
  skillSlug: string
  workspaceId: string
  sessionId?: string
  workingDirectory?: string
}

export default function SkillInfoPage({
  skillSlug,
  workspaceId,
  sessionId,
  workingDirectory,
}: SkillInfoPageProps) {
  const { t } = useTranslation()
  const [skill, setSkill] = useState<LoadedSkill | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [updatingCreatorSkill, setUpdatingCreatorSkill] = useState(false)
  const [updateOperationId, setUpdateOperationId] = useState<string | null>(null)
  const [updateProgress, setUpdateProgress] = useState<CreatorSkillOperationProgress | null>(null)
  const activeWorkspace = useActiveWorkspace()
  const canRevealLocally = !activeWorkspace?.remoteServer

  // Load skill data
  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)

    const loadSkill = async () => {
      try {
        const skills = await window.electronAPI.getSkills(workspaceId, workingDirectory)

        if (!isMounted) return

        // Find the skill by slug
        const found = skills.find((s) => s.slug === skillSlug)
        if (found) {
          setSkill(found)
        } else {
          setError(t('skillInfo.notFound'))
        }
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : t('skillInfo.failedToLoad'))
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadSkill()

    // Subscribe to skill changes
    const unsubscribe = window.electronAPI.onSkillsChanged?.((changedWorkspaceId) => {
      if (changedWorkspaceId !== workspaceId) return
      void window.electronAPI.getSkills(workspaceId, workingDirectory).then(skills => {
        if (!isMounted) return
        const updated = skills.find((s) => s.slug === skillSlug)
        if (updated) setSkill(updated)
      }).catch(() => {
        // Keep the currently displayed Skill if a remote refresh is transiently unavailable.
      })
    })

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [workspaceId, skillSlug, workingDirectory, t])

  const creatorInstallation = skill?.creatorInstallation
  const creatorArtifactId = creatorInstallation?.artifactId
  const creatorArchiveChecksum = creatorInstallation?.archiveChecksum
  const creatorIgnoredVersion = creatorInstallation?.ignoredVersion
  const creatorInstalledVersion = creatorInstallation?.version
  const setCreatorSkillSafetyCheckStates = useSetAtom(
    creatorSkillSafetyCheckStatesAtom,
  )
  const creatorSkillSafetyCheckStates = useAtomValue(
    creatorSkillSafetyCheckStatesAtom,
  )
  const safetyIdentity = (
    creatorArtifactId
    && creatorArchiveChecksum
    && creatorInstalledVersion
  ) ? creatorSkillSafetyIdentityKey({
      workspaceId,
      artifactId: creatorArtifactId,
      version: creatorInstalledVersion,
      archiveChecksum: creatorArchiveChecksum,
    }) : null
  const currentSafetyCheckStatus = safetyIdentity
    ? creatorSkillSafetyCheckStates[safetyIdentity]
    : undefined
  useEffect(() => {
    if (!creatorArtifactId || !creatorArchiveChecksum || !creatorInstalledVersion) {
      setAvailableVersion(null)
      return
    }
    const requestIdentity = creatorSkillSafetyIdentityKey({
      workspaceId,
      artifactId: creatorArtifactId,
      version: creatorInstalledVersion,
      archiveChecksum: creatorArchiveChecksum,
    })
    setCreatorSkillSafetyCheckStates(current => ({
      ...current,
      [requestIdentity]: 'checking',
    }))
    let active = true
    void refreshCreatorSkillSafetyStatus({
      workspaceId,
      artifactId: creatorArtifactId,
      version: creatorInstalledVersion,
      archiveChecksum: creatorArchiveChecksum,
    }).then(refresh => {
      if (!active) return
      const result = refresh.response
      if (!result.success || !refresh.current || !refresh.persisted) {
        setAvailableVersion(null)
        setCreatorSkillSafetyCheckStates(current => ({
          ...current,
          [requestIdentity]: 'failed',
        }))
        return
      }
      setCreatorSkillSafetyCheckStates(current => ({
        ...current,
        [requestIdentity]: 'ok',
      }))
      setAvailableVersion(actionableCreatorSkillSafeVersion({
        candidate: result.safeVersion,
        installedVersion: creatorInstalledVersion,
        ignoredVersion: creatorIgnoredVersion,
        status: result.status,
      }))
    }).catch(() => {
      if (active) {
        setAvailableVersion(null)
        setCreatorSkillSafetyCheckStates(current => ({
          ...current,
          [requestIdentity]: 'failed',
        }))
      }
    })
    return () => {
      active = false
    }
  }, [
    creatorArtifactId,
    creatorArchiveChecksum,
    creatorIgnoredVersion,
    creatorInstalledVersion,
    setCreatorSkillSafetyCheckStates,
    workspaceId,
  ])

  useEffect(() => window.electronAPI.onCreatorSkillProgress(progress => {
    if (progress.operationId === updateOperationId) setUpdateProgress(progress)
  }), [updateOperationId])

  const handleIgnoreCreatorVersion = useCallback(async () => {
    if (!creatorInstallation || !availableVersion) return
    const result = await window.electronAPI.creatorSkillIgnoreVersion({
      workspaceId,
      artifactId: creatorInstallation.artifactId,
      version: creatorInstallation.version,
      archiveChecksum: creatorInstallation.archiveChecksum,
      ignoredVersion: availableVersion,
    })
    if (result.success) setAvailableVersion(null)
    else toast.error(translateCreatorSkillError(t, result))
  }, [availableVersion, creatorInstallation, t, workspaceId])

  const handleUpdateCreatorSkill = useCallback(async () => {
    if (!creatorInstallation || !availableVersion || !sessionId) return
    setUpdatingCreatorSkill(true)
    try {
      const grant = await window.electronAPI.creatorSkillGetDownloadGrant({
        organizationId: creatorInstallation.organizationId,
        artifactId: creatorInstallation.artifactId,
        version: availableVersion,
      })
      if (!grant.success) {
        toast.error(translateCreatorSkillError(t, grant))
        return
      }
      const runInstall = (confirmations: {
        replaceExisting?: boolean
        confirmGlobalOverride?: boolean
        backupLocalChanges?: boolean
      } = {}) => {
        const operationId = crypto.randomUUID()
        setUpdateOperationId(operationId)
        setUpdateProgress(null)
        return window.electronAPI.creatorSkillInstall({
          workspaceId,
          operationId,
          grant: {
            artifactId: grant.artifactId,
            organizationId: grant.organizationId,
            slug: grant.slug,
            version: grant.version,
            url: grant.url,
            expiresAt: grant.expiresAt,
            archiveChecksum: grant.archiveChecksum,
            contentDigest: grant.contentDigest,
            manifest: grant.manifest,
            validationPolicy: grant.validationPolicy,
          },
          ...confirmations,
        })
      }
      let result = await runInstall()
      if (!result.success && result.conflicts?.length) {
        const accepted = window.confirm(creatorSkillConflictConfirmation(t, {
          conflicts: result.conflicts,
          conflictDetails: result.conflictDetails,
        }))
        if (!accepted) return
        result = await runInstall({
          replaceExisting: true,
          confirmGlobalOverride: true,
          backupLocalChanges: true,
        })
      }
      if (!result.success) {
        toast.error(translateCreatorSkillError(t, result), {
          description: creatorSkillErrorDiagnostic(result),
        })
        return
      }
      setAvailableVersion(null)
      toast.success(t('creatorSkills.update.success', { version: availableVersion }))
    } catch (caught) {
      console.error('[Creator Skills] Failed to update Skill:', caught)
      toast.error(translateCreatorSkillError(t))
    } finally {
      setUpdatingCreatorSkill(false)
      setUpdateOperationId(null)
    }
  }, [availableVersion, creatorInstallation, sessionId, t, workspaceId])

  // Handle open in finder
  const handleOpenInFinder = useCallback(async () => {
    if (!skill || !canRevealLocally) return
    try {
      await window.electronAPI.showInFolder(skill.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
        description: message,
      })
    }
  }, [canRevealLocally, skill, t])

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!skill) return

    try {
      if (skill.source !== 'workspace') return
      const outcome = await deleteWorkspaceSkillWithModifiedConfirmation({
        workspaceId,
        slug: skillSlug,
        api: window.electronAPI,
        confirmPermanentDelete: () => window.confirm(
          t('creatorSkills.uninstall.confirmForceDeleteModified'),
        ),
      })
      if (outcome.status === 'error') {
        toast.error(translateCreatorSkillError(t, outcome.result), {
          description: creatorSkillErrorDiagnostic(outcome.result),
        })
        return
      }
      toast.success(
        outcome.status === 'detached'
          ? t('creatorSkills.uninstall.detached')
          : outcome.status === 'force_deleted'
            ? t('creatorSkills.uninstall.forceDeleted')
            : t('skillInfo.deletedSkill', { name: skill.metadata.name }),
      )
      if (outcome.status !== 'detached') navigate(routes.view.skills())
    } catch (err) {
      const payload = err && typeof err === 'object'
        ? err as { code?: unknown; message?: unknown }
        : undefined
      console.error('[Creator Skills] Failed to delete Skill:', err)
      toast.error(translateCreatorSkillError(t, payload))
    }
  }, [skill, workspaceId, skillSlug, t])

  // Handle opening in new window
  const handleOpenInNewWindow = useCallback(() => {
    window.electronAPI.openUrl(`poloai://skills/skill/${skillSlug}?window=focused`)
  }, [skillSlug])

  // Get skill name for header
  const skillName = skill?.metadata.name || skillSlug
  const canDeleteSkill = skill?.source === 'workspace'
  const isSafeRollback = Boolean(
    availableVersion
    && creatorInstalledVersion
    && compareStableCreatorSkillVersion(availableVersion, creatorInstalledVersion) < 0,
  )

  // Format path to show just the skill-relative portion (skills/{slug}/)
  const formatPath = (path: string) => {
    const skillsIndex = path.indexOf('/skills/')
    if (skillsIndex !== -1) {
      return path.slice(skillsIndex + 1) // Remove leading slash, keep "skills/{slug}/..."
    }
    return path
  }

  // Open the skill folder in Finder
  const handleLocationClick = async () => {
    if (!skill || !canRevealLocally) return
    try {
      await window.electronAPI.showInFolder(skill.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
        description: message,
      })
    }
  }

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!skill && !loading && !error ? t('skillInfo.notFound') : undefined}
    >
      <Info_Page.Header
        title={skillName}
        titleMenu={
          <SkillMenu
            skillSlug={skillSlug}
            skillName={skillName}
            onOpenInNewWindow={handleOpenInNewWindow}
            onShowInFinder={handleOpenInFinder}
            canShowInFinder={canRevealLocally}
            onDelete={canDeleteSkill ? handleDelete : undefined}
            canDelete={canDeleteSkill}
            deleteLabel={canDeleteSkill ? t('skillInfo.deleteSkill') : t('skillInfo.managedByProject')}
          />
        }
      />

      {skill && (
        <Info_Page.Content>
          {skill.creatorInstallation?.lastKnownStatus === 'revoked' ? (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{t('creatorSkills.safety.revoked')}</span>
            </div>
          ) : skill.creatorInstallation?.lastKnownStatus === 'archived' ? (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{t('creatorSkills.safety.archived')}</span>
            </div>
          ) : null}
          {creatorSkillHasStaleSafetyStatus({
            ...skill,
            creatorSafetyCheckStatus: currentSafetyCheckStatus,
          }) ? (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{t('creatorSkills.safety.stale')}</span>
            </div>
          ) : null}
          {availableVersion ? (
            <div className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-sm">
              <span className="mr-auto">
                {t(
                  isSafeRollback
                    ? 'creatorSkills.update.rollbackAvailable'
                    : 'creatorSkills.update.available',
                  { version: availableVersion },
                )}
              </span>
              <button
                type="button"
                disabled={updatingCreatorSkill || !sessionId}
                className="rounded-md bg-accent px-2.5 py-1 text-accent-foreground disabled:opacity-50"
                onClick={() => { void handleUpdateCreatorSkill() }}
              >
                {updatingCreatorSkill
                  ? t(`creatorSkills.stage.${updateProgress?.stage ?? 'download'}`)
                  : t(
                    isSafeRollback
                      ? 'creatorSkills.update.rollbackAction'
                      : 'creatorSkills.update.action',
                  )}
              </button>
              {updateProgress?.cancellable && updateOperationId ? (
                <button
                  type="button"
                  className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-foreground/5"
                  onClick={() => {
                    void window.electronAPI.creatorSkillCancel(updateOperationId)
                  }}
                >
                  {t('common.cancel')}
                </button>
              ) : null}
              {!isSafeRollback ? (
                <button
                  type="button"
                  disabled={updatingCreatorSkill}
                  className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-foreground/5"
                  onClick={() => { void handleIgnoreCreatorVersion() }}
                >
                  {t('creatorSkills.update.ignore')}
                </button>
              ) : null}
            </div>
          ) : null}
          {/* Hero: Avatar, title, and description */}
          <Info_Page.Hero
            avatar={<SkillAvatar skill={skill} fluid workspaceId={workspaceId} />}
            title={skill.metadata.name}
            tagline={skill.metadata.description}
          />

          {/* Metadata */}
          <Info_Section
            title={t('skillInfo.metadata')}
            actions={
              // EditPopover for AI-assisted metadata editing (name, description in frontmatter)
              <EditPopover
                trigger={<EditButton />}
                {...getEditConfig('skill-metadata', skill.path)}
                secondaryAction={{
                  label: t('common.editFile'),
                  filePath: `${skill.path}/SKILL.md`,
                }}
              />
            }
          >
            <Info_Table>
              <Info_Table.Row label={t('common.slug')} value={skill.slug} />
              <Info_Table.Row label={t('common.name')}>{skill.metadata.name}</Info_Table.Row>
              <Info_Table.Row label={t('common.description')}>
                {skill.metadata.description}
              </Info_Table.Row>
              <Info_Table.Row label={t('common.source')}>
                {skill.source === 'project' ? t('skillInfo.sourceProject') :
                 skill.source === 'global' ? t('skillInfo.sourceGlobal') :
                 t('skillInfo.sourceWorkspace')}
              </Info_Table.Row>
              <Info_Table.Row label={t('common.location')}>
                <button
                  onClick={handleLocationClick}
                  className="hover:underline cursor-pointer text-left"
                >
                  {formatPath(skill.path)}
                </button>
              </Info_Table.Row>
              {skill.metadata.requiredSources && skill.metadata.requiredSources.length > 0 && (
                <Info_Table.Row label={t('skillInfo.requiredSources')}>
                  {skill.metadata.requiredSources.join(', ')}
                </Info_Table.Row>
              )}
            </Info_Table>
          </Info_Section>

          {/* Advisory tool requests never grant or remember permission. */}
          {skill.metadata.alwaysAllow && skill.metadata.alwaysAllow.length > 0 && (
            <Info_Section title={t('skillInfo.requestedTools')}>
              <div className="space-y-2 px-4 py-3">
                <p className="text-xs text-muted-foreground mb-3">
                  {t('skillInfo.requestedToolsDesc')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {skill.metadata.alwaysAllow.map(tool => (
                    <code
                      key={tool}
                      className="rounded bg-foreground/5 px-2 py-1 text-xs text-foreground/80"
                    >
                      {tool}
                    </code>
                  ))}
                </div>
              </div>
            </Info_Section>
          )}

          {/* Instructions */}
          <Info_Section
            title={t('skillInfo.instructions')}
            actions={
              // EditPopover for AI-assisted editing with "Edit File" as secondary action
              <EditPopover
                trigger={<EditButton />}
                {...getEditConfig('skill-instructions', skill.path)}
                secondaryAction={{
                  label: t('common.editFile'),
                  filePath: `${skill.path}/SKILL.md`,
                }}
              />
            }
          >
            <Info_Markdown maxHeight={540} fullscreen>
              {skill.content || t('skillInfo.noInstructions')}
            </Info_Markdown>
          </Info_Section>

        </Info_Page.Content>
      )}
    </Info_Page>
  )
}
