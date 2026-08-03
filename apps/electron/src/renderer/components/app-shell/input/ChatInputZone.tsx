import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@z-h-ai/shared/labels'
import type { PermissionMode } from '@z-h-ai/shared/agent/modes'
import type { SessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { AlertTriangle } from 'lucide-react'

export interface ChatInputStatusBanner {
  variant: 'info' | 'destructive'
  message: string
}

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  sessionLabels?: string[]
  labels?: LabelConfig[]
  onLabelsChange?: (labels: string[]) => void
  sessionStatuses?: SessionStatus[]
  currentSessionStatus?: string
  onSessionStatusChange?: (stateId: string) => void
  statusBanner?: ChatInputStatusBanner | null
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  sessionLabels = [],
  labels = [],
  onLabelsChange,
  sessionStatuses = [],
  currentSessionStatus = 'todo',
  onSessionStatusChange,
  statusBanner,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(null)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const handleLabelAdd = React.useCallback((labelId: string) => {
    const current = sessionLabels || []
    if (current.includes(labelId)) return

    onLabelsChange?.([...current, labelId])

    const config = flattenLabels(labels || []).find(label => label.id === labelId)
    if (config?.valueType) {
      setAutoOpenLabelId(labelId)
    }
  }, [labels, onLabelsChange, sessionLabels])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
      className,
    )}>
      {shouldShowOptionBadges && (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          tasks={tasks}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          onKillTask={onKillTask}
          onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
          sessionLabels={sessionLabels}
          labels={labels}
          onLabelsChange={onLabelsChange}
          onRemoveLabel={(labelId) => {
            const next = (sessionLabels || []).filter(entry => entry !== labelId && !entry.startsWith(`${labelId}::`))
            onLabelsChange?.(next)
          }}
          autoOpenLabelId={autoOpenLabelId}
          onAutoOpenConsumed={() => setAutoOpenLabelId(null)}
          sessionStatuses={sessionStatuses}
          currentSessionStatus={currentSessionStatus}
          onSessionStatusChange={onSessionStatusChange}
        />
      )}

      {statusBanner && (
        <div
          className={cn(
            'mb-1.5 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] leading-5 animate-[chat-status-slide-up_250ms_ease-out]',
            statusBanner.variant === 'info'
              ? 'bg-info/10 text-info'
              : 'bg-destructive/10 text-destructive',
          )}
          role="status"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{statusBanner.message}</span>
        </div>
      )}

      <InputErrorBoundary
        sessionId={sessionId}
        resetKey={inputResetKey}
        onClearDraft={handleClearDraft}
      >
        <InputContainer
          {...inputProps}
          compactMode={compactMode}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          labels={labels}
          sessionLabels={sessionLabels}
          onLabelAdd={handleLabelAdd}
          sessionFolderPath={sessionFolderPath}
          sessionId={sessionId}
          currentSessionStatus={currentSessionStatus}
        />
      </InputErrorBoundary>
    </div>
  )
}
