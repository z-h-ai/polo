import * as React from 'react'
import {
  CreatorSkillSafetyScheduler,
  type CreatorSkillSafetyScheduleItem,
} from '@/lib/creator-skill-safety-scheduler'
import { actionableCreatorSkillSafeVersion } from '@/lib/creator-skill-version'
import type { LoadedSkill } from '../../shared/types'

interface ScheduledSafetyCheck extends CreatorSkillSafetyScheduleItem {
  skill: LoadedSkill
}

export interface CreatorSkillSafeVersionCandidate {
  workspaceId: string
  artifactId: string
  slug: string
  version: string
}

export function creatorSkillSafeVersionCandidateKey(
  workspaceId: string,
  artifactId: string,
  slug: string,
): string {
  return `${workspaceId}\0${artifactId}\0${slug}`
}

export function selectCreatorSkillSafeVersions(
  candidates: Record<string, CreatorSkillSafeVersionCandidate>,
  skills: LoadedSkill[],
  workspaceId?: string,
): Record<string, string> {
  if (!workspaceId) return {}
  const result: Record<string, string> = {}
  for (const skill of skills) {
    const installed = skill.creatorInstallation
    if (!installed) continue
    const candidate = candidates[creatorSkillSafeVersionCandidateKey(
      workspaceId,
      installed.artifactId,
      skill.slug,
    )]
    if (!candidate) continue
    const actionable = actionableCreatorSkillSafeVersion({
      candidate: candidate.version,
      installedVersion: installed.version,
      ignoredVersion: installed.ignoredVersion,
      status: installed.lastKnownStatus ?? 'active',
    })
    if (actionable) result[skill.slug] = actionable
  }
  return result
}

export function useCreatorSkillSafetyMonitor(
  skills: LoadedSkill[],
  workspaceId?: string,
): Record<string, string> {
  const scheduler = React.useRef<CreatorSkillSafetyScheduler<ScheduledSafetyCheck> | null>(null)
  if (!scheduler.current) {
    scheduler.current = new CreatorSkillSafetyScheduler()
  }
  const [safeVersionCandidates, setSafeVersionCandidates] = React.useState<
    Record<string, CreatorSkillSafeVersionCandidate>
  >({})
  const activeWorkspaceScope = React.useRef(workspaceId)
  activeWorkspaceScope.current = workspaceId

  React.useEffect(() => {
    const isCurrentScope = () => activeWorkspaceScope.current === workspaceId
    if (!workspaceId) {
      scheduler.current?.update([], async () => true)
      setSafeVersionCandidates({})
      return
    }

    setSafeVersionCandidates(current => {
      let changed = false
      const next = { ...current }
      for (const [key, candidate] of Object.entries(next)) {
        const installed = skills.find(skill =>
          skill.slug === candidate.slug
          && skill.creatorInstallation?.artifactId === candidate.artifactId
        )?.creatorInstallation
        if (
          !installed
          || candidate.workspaceId !== workspaceId
          || !actionableCreatorSkillSafeVersion({
            candidate: candidate.version,
            installedVersion: installed.version,
            ignoredVersion: installed.ignoredVersion,
            status: installed.lastKnownStatus ?? 'active',
          })
        ) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : current
    })

    const checks = skills.flatMap<ScheduledSafetyCheck>(skill => {
      const installed = skill.creatorInstallation
      return installed ? [{
        key: `${workspaceId}\0${installed.artifactId}\0${installed.version}\0${installed.archiveChecksum}`,
        lastCheckedAt: installed.lastCheckedAt,
        skill,
      }] : []
    })
    scheduler.current?.update(checks, async ({ skill }) => {
      const installed = skill.creatorInstallation
      if (!installed) return true
      try {
        const result = await window.electronAPI.creatorSkillGetSafetyStatus({
          artifactId: installed.artifactId,
          version: installed.version,
          archiveChecksum: installed.archiveChecksum,
        })
        if (!result.success || !isCurrentScope()) return false
        setSafeVersionCandidates(current => {
          const next = { ...current }
          const actionable = actionableCreatorSkillSafeVersion({
            candidate: result.safeVersion,
            installedVersion: installed.version,
            ignoredVersion: installed.ignoredVersion,
            status: result.status,
          })
          if (actionable) {
            const key = creatorSkillSafeVersionCandidateKey(
              workspaceId,
              installed.artifactId,
              skill.slug,
            )
            next[key] = {
              workspaceId,
              artifactId: installed.artifactId,
              slug: skill.slug,
              version: actionable,
            }
          } else {
            delete next[creatorSkillSafeVersionCandidateKey(
              workspaceId,
              installed.artifactId,
              skill.slug,
            )]
          }
          return next
        })
        const updateResult = await window.electronAPI.creatorSkillUpdateSafetyStatus({
          workspaceId,
          status: {
            artifactId: result.artifactId,
            version: result.version,
            archiveChecksum: result.archiveChecksum,
            status: result.status,
            safeVersion: result.safeVersion,
          },
          checkedAt: new Date().toISOString(),
        })
        return updateResult.success
      } catch {
        return false
      }
    })
  }, [skills, workspaceId])

  React.useEffect(() => () => {
    activeWorkspaceScope.current = undefined
    scheduler.current?.dispose()
  }, [])

  return React.useMemo(
    () => selectCreatorSkillSafeVersions(
      safeVersionCandidates,
      skills,
      workspaceId,
    ),
    [safeVersionCandidates, skills, workspaceId],
  )
}
