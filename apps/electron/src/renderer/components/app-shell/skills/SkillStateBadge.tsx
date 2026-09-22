import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { StatusPill } from '@/components/hifi'
import type {
  DiscoverRowState,
  LocalSkillRowState,
} from './types'

export type SkillBadgeState = LocalSkillRowState | DiscoverRowState

export interface SkillStateBadgeProps {
  state: SkillBadgeState
  /** Version shown on the update-available pill. */
  version?: string
  className?: string
}

const TONE_BY_STATE: Record<SkillBadgeState, 'success' | 'neutral' | 'accent' | 'destructive'> = {
  enabled: 'success',
  disabled: 'neutral',
  'installed-not-enabled': 'neutral',
  installed: 'neutral',
  'update-available': 'accent',
  installable: 'neutral',
  restricted: 'destructive',
}

const KEY_BY_STATE: Record<SkillBadgeState, string> = {
  enabled: 'skillsManager.state.enabled',
  disabled: 'skillsManager.state.disabled',
  'installed-not-enabled': 'skillsManager.state.installedNotEnabled',
  installed: 'skillsManager.state.installed',
  'update-available': 'skillsManager.state.updateAvailable',
  installable: 'skillsManager.state.installable',
  restricted: 'skillsManager.state.restricted',
}

/**
 * SkillStateBadge — the status pill group for skill rows (已启用 / 已停用 /
 * 可更新 / 可安装 / 授权已失效). Purely presentational on top of the shared
 * hifi StatusPill.
 */
export function SkillStateBadge({ state, version, className }: SkillStateBadgeProps) {
  const { t } = useTranslation()
  const label = state === 'update-available' && version
    ? t('skillsManager.state.updateAvailable', { version })
    : t(KEY_BY_STATE[state])
  return (
    <StatusPill tone={TONE_BY_STATE[state]} className={className}>
      {label}
    </StatusPill>
  )
}
