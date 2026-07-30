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

export function useCreatorSkillSafetyMonitor(
  skills: LoadedSkill[],
  workspaceId?: string,
): Record<string, string> {
  const scheduler = React.useRef<CreatorSkillSafetyScheduler<ScheduledSafetyCheck> | null>(null)
  if (!scheduler.current) {
    scheduler.current = new CreatorSkillSafetyScheduler()
  }
  const [safeVersions, setSafeVersions] = React.useState<Record<string, string>>({})
  const activeWorkspaceScope = React.useRef(workspaceId)
  activeWorkspaceScope.current = workspaceId

  React.useEffect(() => {
    const isCurrentScope = () => activeWorkspaceScope.current === workspaceId
    if (!workspaceId) {
      scheduler.current?.update([], async () => true)
      setSafeVersions({})
      return
    }

    setSafeVersions(current => {
      let changed = false
      const next = { ...current }
      for (const [slug, candidate] of Object.entries(next)) {
        const installed = skills.find(skill => skill.slug === slug)?.creatorInstallation
        if (
          !installed
          || !actionableCreatorSkillSafeVersion({
            candidate,
            installedVersion: installed.version,
            ignoredVersion: installed.ignoredVersion,
            status: installed.lastKnownStatus ?? 'active',
          })
        ) {
          delete next[slug]
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
        setSafeVersions(current => {
          const next = { ...current }
          const actionable = actionableCreatorSkillSafeVersion({
            candidate: result.safeVersion,
            installedVersion: installed.version,
            ignoredVersion: installed.ignoredVersion,
            status: result.status,
          })
          if (actionable) {
            next[skill.slug] = actionable
          } else {
            delete next[skill.slug]
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

  return safeVersions
}
