import type { LoadedSkill } from '../../shared/types'

const SAFETY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000

export function creatorSkillHasStaleSafetyStatus(
  skill: LoadedSkill,
  now = Date.now(),
): boolean {
  const installed = skill.creatorInstallation
  if (!installed) return false
  if (skill.creatorSafetyCheckStatus === 'failed') return true
  if (!installed.lastCheckedAt) return true
  const checkedAt = Date.parse(installed.lastCheckedAt)
  return !Number.isFinite(checkedAt)
    || now - checkedAt > SAFETY_REFRESH_INTERVAL_MS
}
