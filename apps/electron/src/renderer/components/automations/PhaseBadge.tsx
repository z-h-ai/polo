/**
 * PhaseBadge
 *
 * Colored badge indicating the phase/timing of an automation trigger event.
 * Derives from getEventCategory() to avoid duplicating event classification.
 */

import { useTranslation } from 'react-i18next'
import { getEventCategory, type AutomationTrigger, type EventCategory } from './types'
import { Info_Badge, type BadgeColor } from '@/components/info'

// POO-179: labels are i18n keys resolved at render time; category values stay untouched.
const CATEGORY_BADGE: Record<EventCategory, { labelKey: string; color: BadgeColor }> = {
  'scheduled':   { labelKey: 'automations.phase.scheduled', color: 'success' },
  'agent-pre':   { labelKey: 'automations.phase.before',    color: 'warning' },
  'agent-post':  { labelKey: 'automations.phase.after',     color: 'success' },
  'agent-error': { labelKey: 'automations.phase.onError',   color: 'destructive' },
  'label':       { labelKey: 'automations.phase.event',     color: 'default' },
  'permission':  { labelKey: 'automations.phase.event',     color: 'default' },
  'flag':        { labelKey: 'automations.phase.event',     color: 'default' },
  'todo':        { labelKey: 'automations.phase.event',     color: 'default' },
  'session':     { labelKey: 'automations.phase.event',     color: 'default' },
  'other':       { labelKey: 'automations.phase.event',     color: 'default' },
}

export interface PhaseBadgeProps {
  event: AutomationTrigger
  className?: string
}

export function PhaseBadge({ event, className }: PhaseBadgeProps) {
  const { t } = useTranslation()
  const category = getEventCategory(event)
  const badge = CATEGORY_BADGE[category]

  return (
    <Info_Badge color={badge.color} className={className}>
      {t(badge.labelKey)}
    </Info_Badge>
  )
}
