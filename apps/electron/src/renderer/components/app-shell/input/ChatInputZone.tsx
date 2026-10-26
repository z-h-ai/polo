import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@polo-ai/shared/labels'
import type { PermissionMode } from '@polo-ai/shared/agent/modes'
import { isGoalTerminal } from '@polo-ai/shared/protocol'
import type { SessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { GoalStrip } from '../GoalStrip'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { AlertTriangle } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { goalModeActiveAtomFamily, goalProjectionAtomFamily } from '../../../atoms/sessions'
import { useOptionalAppShellContext } from '../../../context/AppShellContext'

export interface ChatInputStatusBanner {
  variant: 'info' | 'destructive'
  message: string
  /** Journey #8: optional technical detail, rendered collapsed. */
  detail?: string
  /** POO-144: optional explicit action (e.g. retry sync) — user-triggered only */
  actionLabel?: string
  onAction?: () => void
  /** Journey #8 (review F4): optional dismiss (e.g. discard preserved draft). */
  dismissLabel?: string
  onDismiss?: () => void
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
  const { t } = useTranslation()
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(null)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode

  // POO-134: Goal strip rides above the option badges. The projection is
  // server-authoritative. Journey #5: the LAST record stays readable after
  // the goal completes/ends — the projection retains it (currentGoalId is
  // cleared, `goal` is kept), so the strip renders it read-only with its
  // verification receipt instead of vanishing; re-entering the session
  // restores the same projection.
  const goalProjection = useAtomValue(goalProjectionAtomFamily(sessionId))
  const goal = goalProjection?.goal ?? null
  const goalTerminal = !!goal && isGoalTerminal(goal.status)
  const goalModeArmed = useAtomValue(goalModeActiveAtomFamily(sessionId))
  const setGoalModeActive = useSetAtom(goalModeActiveAtomFamily(sessionId))
  const shell = useOptionalAppShellContext()
  const handleGoalCommand = React.useCallback((command: 'goalPause' | 'goalResume' | 'goalEnd') => {
    shell?.onGoalCommand?.(sessionId, command)
  }, [shell, sessionId])

  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type === 'question'
    ? `question-${(inputProps.structuredInput.data as { requestId?: string }).requestId ?? 'unknown'}`
    : inputProps.structuredInput?.type ?? 'freeform'}`

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
    <div
      data-testid={compactMode ? 'chat-input-compact' : 'chat-input'}
      className={cn(
        CHAT_LAYOUT.maxWidth,
        'mx-auto w-full mt-1',
        compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
        className,
      )}
    >
      {goal && (
        <GoalStrip
          sessionId={sessionId}
          goal={goal}
          onPause={() => handleGoalCommand('goalPause')}
          onResume={() => handleGoalCommand('goalResume')}
          onOpenFile={shell?.onOpenFile}
        />
      )}

      {shouldShowOptionBadges && (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          goalModeActive={goalModeArmed || (!!goal && !goalTerminal)}
          goalRunning={!!goal && !goalTerminal}
          onGoalModeToggle={() => setGoalModeActive(v => !v)}
          onGoalEnd={() => handleGoalCommand('goalEnd')}
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
            'mb-1.5 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] leading-5 animate-[chat-status-slide-up_250ms_ease-out]',
            statusBanner.variant === 'info'
              ? 'bg-info/10 text-info'
              : 'bg-destructive/10 text-destructive',
          )}
          role="status"
          data-testid="chat-status-banner"
          data-banner-variant={statusBanner.variant}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <span>{statusBanner.message}</span>
            {statusBanner.detail && (
              <details data-testid="chat-status-banner-detail" className="mt-1">
                <summary className="cursor-pointer select-none text-[12px] opacity-70 transition-opacity hover:opacity-100">
                  {t('chat.sendFailed.detailSummary')}
                </summary>
                <div className="mt-1 max-h-24 overflow-y-auto break-words font-mono text-[11px] leading-4 opacity-70">
                  {statusBanner.detail}
                </div>
              </details>
            )}
          </div>
          {statusBanner.actionLabel && statusBanner.onAction && (
            <button
              type="button"
              data-testid="chat-status-banner-action"
              className="ml-auto shrink-0 rounded-md text-[13px] font-medium underline underline-offset-2 transition-opacity hover:opacity-80"
              onClick={statusBanner.onAction}
            >
              {statusBanner.actionLabel}
            </button>
          )}
          {statusBanner.dismissLabel && statusBanner.onDismiss && (
            <button
              type="button"
              data-testid="chat-status-banner-dismiss"
              className={cn(
                'shrink-0 rounded-md text-[13px] font-medium underline underline-offset-2 transition-opacity hover:opacity-80',
                statusBanner.actionLabel && statusBanner.onAction ? '' : 'ml-auto',
              )}
              onClick={statusBanner.onDismiss}
            >
              {statusBanner.dismissLabel}
            </button>
          )}
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
