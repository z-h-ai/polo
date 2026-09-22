import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { RunningActivityEntry, RunningActivityStatus } from './useSpaceSwitchFlow'

/** g4 `.row-state` tone per stop status (info / success / destructive). */
const STATUS_TONE: Record<RunningActivityStatus, string> = {
  running: 'text-hifi-info',
  stopping: 'text-hifi-info',
  stopped: 'text-hifi-success',
  failed: 'text-hifi-destructive',
}

export interface RunningActivitiesPanelProps {
  /** Stop ledger entries with per-item status (g4 `.dialog-list` / `.dialog-row`). */
  items: RunningActivityEntry[]
  className?: string
}

/**
 * RunningActivitiesPanel — the stop ledger list of a space switch
 * (prototype M02 confirm/stopping/stopFailed/stopCancel/targetLoading).
 * One row per activity: status label (运行中/停止中/已停止/失败) + name +
 * type line (App / 助手生成 + detail).
 */
export function RunningActivitiesPanel({ items, className }: RunningActivitiesPanelProps) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <div
      data-testid="running-activities-panel"
      className={cn('overflow-hidden rounded-hifi-md border border-hifi-border', className)}
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid="running-activity-row"
          className="flex items-center gap-2.5 border-b border-hifi-border p-[11px] last:border-b-0"
        >
          <span
            data-testid="running-activity-status"
            className={cn('w-14 shrink-0 text-hifi-xs leading-[1.4]', STATUS_TONE[item.status])}
          >
            {t(`spaceSwitch.activity.status.${item.status}`)}
          </span>
          <span className="grid min-w-0 flex-1 gap-[3px]">
            <strong className="truncate text-hifi-base font-medium text-hifi-foreground">
              {item.name}
            </strong>
            <small className="m-0 truncate text-hifi-xs leading-[1.4] text-hifi-fg-50">
              {t(`spaceSwitch.activity.type.${item.kind}`)}
              {item.detail ? ` · ${item.detail}` : ''}
            </small>
          </span>
        </div>
      ))}
    </div>
  )
}
