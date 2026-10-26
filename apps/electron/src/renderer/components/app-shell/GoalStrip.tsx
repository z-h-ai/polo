/**
 * POO-134 Goal strip — the read-only Goal bar above the chat input.
 *
 * Rendering is a pure projection of the server-owned Goal record: summary,
 * accumulated runtime (`computeGoalElapsedMs`, second-granularity tick while
 * the server clock runs), status badge, and exactly one action button
 * (active→pause, paused→resume, verifying shows the running state instead).
 * The strip expands upward into a read-only todo panel; expansion state is
 * per-session via `goalExpandedAtomFamily`.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom } from 'jotai'
import { Check, ChevronDown, ChevronUp, Circle, CircleDot, Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isGoalRunning, type GoalRecord, type GoalTodoItem } from '@polo-ai/shared/protocol'
import { goalExpandedAtomFamily } from '../../atoms/sessions'
import { formatGoalElapsed, goalElapsedMs } from './goal-progress'

export interface GoalStripProps {
  sessionId: string
  goal: GoalRecord
  onPause?: () => void
  onResume?: () => void
}

const TODO_STATUS_META: Record<GoalTodoItem['status'], { icon: React.ReactNode; className: string; labelKey: string }> = {
  completed: {
    icon: <Check className="h-3 w-3" strokeWidth={2.5} />,
    className: 'border-success/40 bg-success/10 text-success',
    labelKey: 'goal.todoStatusCompleted',
  },
  in_progress: {
    icon: <CircleDot className="h-3 w-3" strokeWidth={2.5} />,
    className: 'border-accent/40 bg-accent/10 text-accent',
    labelKey: 'goal.todoStatusInProgress',
  },
  pending: {
    icon: <Circle className="h-2.5 w-2.5" strokeWidth={2.5} />,
    className: 'border-foreground/20 bg-transparent text-muted-foreground',
    labelKey: 'goal.todoStatusPending',
  },
}

export function GoalStrip({ sessionId, goal, onPause, onResume }: GoalStripProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useAtom(goalExpandedAtomFamily(sessionId))
  const running = isGoalRunning(goal.status)
  const [now, setNow] = React.useState(() => Date.now())
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelId = React.useId()

  // Second-granularity strip clock — tick ONLY while the server clock runs;
  // paused/waiting/failed goals show the frozen accumulated time.
  React.useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const collapse = React.useCallback(() => {
    setExpanded(false)
    triggerRef.current?.focus()
  }, [setExpanded])

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && expanded) {
      e.stopPropagation()
      collapse()
    }
  }, [expanded, collapse])

  // Keep hidden panel content out of the Tab order while collapsed
  // (0fr rows hide it visually but not from keyboard focus).
  const setPanelInnerRef = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    if (expanded) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [expanded])

  const todos = React.useMemo(
    () => [...goal.todos].sort((a, b) => a.seq - b.seq),
    [goal.todos],
  )
  const completedCount = todos.filter(td => td.status === 'completed').length

  const emptyKey = todos.length === 0
    ? goal.status === 'paused' && goal.pauseReason === 'awaiting_user'
      ? 'goal.emptyPaused'
      : running
        ? 'goal.emptyDecomposing'
        : 'goal.emptyWaiting'
    : null

  // Exactly one action slot: pause while active, resume while paused;
  // verifying is still running server-side, so it shows the running state.
  const action = goal.status === 'active'
    ? { label: t('goal.pause'), onClick: onPause, testId: 'goal-strip-pause' }
    : goal.status === 'paused'
      ? { label: t('goal.resume'), onClick: onResume, testId: 'goal-strip-resume' }
      : null

  return (
    <div
      data-testid="goal-strip"
      data-goal-status={goal.status}
      className={cn(
        'mb-1.5 overflow-hidden rounded-lg border border-foreground/10 bg-[color-mix(in_srgb,var(--background)_97%,var(--foreground)_3%)]',
        'animate-[chat-status-slide-up_250ms_ease-out]',
      )}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          ref={triggerRef}
          type="button"
          data-testid="goal-strip-trigger"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded(v => !v)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-1 pr-1.5 text-left text-[13px]',
            'outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-accent/50',
          )}
        >
          {expanded
            ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <Target className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span
            data-testid="goal-strip-summary"
            className="min-w-0 flex-1 truncate font-medium text-foreground/90"
          >
            {goal.objective}
          </span>
          <span
            data-testid="goal-strip-elapsed"
            title={t('goal.elapsedLabel')}
            className="shrink-0 tabular-nums text-muted-foreground"
          >
            {formatGoalElapsed(goalElapsedMs(goal, now))}
          </span>
          <span
            data-testid="goal-strip-status"
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none',
              running ? 'bg-success/10 text-success' : 'bg-foreground/5 text-muted-foreground',
            )}
          >
            {running ? t('goal.statusRunning') : t('goal.statusPaused')}
          </span>
        </button>
        {action ? (
          <button
            type="button"
            data-testid={action.testId}
            onClick={action.onClick}
            className={cn(
              'shrink-0 rounded-md px-2 py-1 text-xs font-medium outline-none transition-colors',
              'text-foreground/70 hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-accent/50',
            )}
          >
            {action.label}
          </button>
        ) : goal.status === 'verifying' ? (
          <span
            data-testid="goal-strip-verifying"
            className="shrink-0 px-2 text-xs font-medium text-muted-foreground"
          >
            {t('goal.statusRunning')}
          </span>
        ) : null}
      </div>

      <div
        id={panelId}
        data-testid="goal-strip-panel"
        data-open={expanded}
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div
          ref={setPanelInnerRef}
          aria-hidden={!expanded}
          className="min-h-0 overflow-hidden"
        >
          <div className="border-t border-foreground/10 px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t('goal.panelHeading')}
              </span>
              <span data-testid="goal-strip-count" className="text-xs tabular-nums text-muted-foreground">
                {t('goal.completedCount', { completed: completedCount, total: todos.length })}
              </span>
            </div>
            {emptyKey ? (
              <div
                data-testid="goal-todos-empty"
                className="py-2 text-[13px] text-muted-foreground"
              >
                {t(emptyKey)}
              </div>
            ) : (
              <ul
                data-testid="goal-todo-list"
                aria-label={t('goal.todoListLabel')}
                className="max-h-[240px] space-y-1 overflow-y-auto"
              >
                {todos.map(td => {
                  const meta = TODO_STATUS_META[td.status]
                  return (
                    <li
                      key={td.id}
                      data-testid={`goal-todo-item-${td.id}`}
                      data-todo-status={td.status}
                      className="flex items-start gap-2 text-[13px] leading-5 text-foreground/85"
                    >
                      <span
                        aria-label={t(meta.labelKey)}
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                          meta.className,
                          td.status === 'in_progress' && running
                            // Execution pulse only while the Goal actually runs —
                            // a paused Goal never animates.
                            && 'animate-[goal-todo-pulse_2s_ease-in-out_infinite]',
                        )}
                      >
                        {meta.icon}
                      </span>
                      <span className="min-w-0 break-words">{td.label}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
