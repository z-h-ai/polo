/**
 * POO-134 Goal strip — the read-only Goal bar above the chat input.
 *
 * Rendering is a pure projection of the server-owned Goal record: summary,
 * accumulated runtime (`computeGoalElapsedMs`, second-granularity tick while
 * the server clock runs), status badge, and at most one action button
 * (active→pause, paused→resume, verifying shows the running state instead).
 * The strip expands upward into a read-only todo panel.
 *
 * Journey #5: the badge distinguishes WHY a goal is not running
 * (awaiting_user/error/no_progress/restart_required) instead of a blanket
 * 「已暂停」, terminal records stay readable (completed/ended badge, no
 * resume affordance), and the panel shows the independent verification
 * receipt — per-criterion verdicts with the evidence bound to THIS goal,
 * unknown facts rendered as 未知, and no fabricated verification duration.
 * Expansion state is per-session via `goalExpandedAtomFamily`.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom } from 'jotai'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  FileText,
  MessageSquareText,
  ShieldQuestion,
  Target,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isGoalRunning, type GoalRecord, type GoalTodoItem } from '@polo-ai/shared/protocol'
import { goalExpandedAtomFamily } from '../../atoms/sessions'
import { formatGoalElapsed, goalElapsedMs } from './goal-progress'
import { GOAL_BADGE_META, goalBadgeState } from './goal-status'
import { describeGoalVerification } from './goal-verification-view'

export interface GoalStripProps {
  sessionId: string
  goal: GoalRecord
  onPause?: () => void
  onResume?: () => void
  /** Journey #5: opens `file` evidence through the app's existing file entry. */
  onOpenFile?: (path: string) => void
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

const VERIFICATION_STATUS_META = {
  passed: {
    icon: <Check className="h-3 w-3" strokeWidth={2.5} />,
    className: 'bg-success/10 text-success',
    labelKey: 'goal.verificationPassed',
  },
  not_satisfied: {
    icon: <ShieldQuestion className="h-3 w-3" strokeWidth={2.5} />,
    className: 'bg-info/10 text-info',
    labelKey: 'goal.verificationNotSatisfied',
  },
  failed: {
    icon: <X className="h-3 w-3" strokeWidth={2.5} />,
    className: 'bg-destructive/10 text-destructive',
    labelKey: 'goal.verificationFailed',
  },
} as const

export function GoalStrip({ sessionId, goal, onPause, onResume, onOpenFile }: GoalStripProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useAtom(goalExpandedAtomFamily(sessionId))
  const running = isGoalRunning(goal.status)
  const badge = GOAL_BADGE_META[goalBadgeState(goal)]
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
  const verification = React.useMemo(() => describeGoalVerification(goal), [goal])

  const emptyKey = todos.length === 0
    ? goal.status === 'completed' || goal.status === 'ended'
      ? 'goal.panelTerminalEmpty'
      : goal.status === 'paused' && goal.pauseReason === 'awaiting_user'
        ? 'goal.emptyPaused'
        : running
          ? 'goal.emptyDecomposing'
          : 'goal.emptyWaiting'
    : null

  // Exactly one action slot: pause while active, resume while paused;
  // verifying is still running server-side, so it shows the running state.
  // Terminal records offer NO resume/start-over affordance (journey #5).
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
        'animate-[chat-status-slide-up_250ms_ease-out] motion-reduce:animate-none',
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
            title={badge.hintKey ? t(badge.hintKey) : undefined}
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none',
              badge.className,
            )}
          >
            {t(badge.labelKey)}
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
            {t('goal.statusVerifying')}
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
                            && 'animate-[goal-todo-pulse_2s_ease-in-out_infinite] motion-reduce:animate-none',
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

            {verification && (
              <div
                data-testid="goal-verification"
                data-verification-status={verification.status}
                className="mt-2 border-t border-foreground/10 pt-2"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('goal.verificationHeading')}
                  </span>
                  <span
                    data-testid="goal-verification-status"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none',
                      VERIFICATION_STATUS_META[verification.status].className,
                    )}
                  >
                    {VERIFICATION_STATUS_META[verification.status].icon}
                    {t(VERIFICATION_STATUS_META[verification.status].labelKey)}
                  </span>
                </div>
                <div data-testid="goal-verification-meta" className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span data-testid="goal-verification-model">
                    {t('goal.verificationModel', {
                      model: verification.model ?? t('goal.evidenceUnknown'),
                    })}
                  </span>
                  <span data-testid="goal-verification-time">
                    {t('goal.verificationAt', {
                      time: new Date(verification.verifiedAt).toLocaleString(),
                    })}
                  </span>
                </div>
                {verification.criteria.length > 0 && (
                  <ul data-testid="goal-criterion-list" className="space-y-1">
                    {verification.criteria.map((c, i) => (
                      <li
                        key={i}
                        data-testid={`goal-criterion-${i}`}
                        data-criterion-passed={c.passed}
                        className="flex items-start gap-2 text-[13px] leading-5 text-foreground/85"
                      >
                        <span
                          aria-label={t(c.passed ? 'goal.criterionPassed' : 'goal.criterionNotSatisfied')}
                          className={cn(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                            c.passed
                              ? 'border-success/40 bg-success/10 text-success'
                              : 'border-destructive/40 bg-destructive/10 text-destructive',
                          )}
                        >
                          {c.passed
                            ? <Check className="h-2.5 w-2.5" strokeWidth={3} />
                            : <X className="h-2.5 w-2.5" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 break-words">
                          {c.criterion}
                          {c.note && (
                            <span className="block text-[11px] text-muted-foreground">{c.note}</span>
                          )}
                          {c.evidence.length > 0 && (
                            <span className="mt-0.5 flex flex-wrap gap-1" data-testid="goal-criterion-evidence">
                              {c.evidence.map((ev, j) => ev.status === 'known-file' && ev.path ? (
                                <button
                                  key={j}
                                  type="button"
                                  data-testid={`goal-evidence-file-${j}`}
                                  data-evidence-kind="file"
                                  onClick={() => onOpenFile?.(ev.path!)}
                                  title={t('goal.evidenceOpenFile')}
                                  className={cn(
                                    'inline-flex max-w-full items-center gap-1 rounded border border-foreground/15 px-1 py-0.5 text-[11px]',
                                    'text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-accent/50',
                                  )}
                                >
                                  <FileText className="h-2.5 w-2.5 shrink-0" />
                                  <span className="truncate">{ev.label}</span>
                                </button>
                              ) : ev.status === 'known-message' ? (
                                <span
                                  key={j}
                                  data-testid={`goal-evidence-message-${j}`}
                                  data-evidence-kind="message"
                                  title={ev.messageId}
                                  className="inline-flex max-w-full items-center gap-1 rounded border border-foreground/15 px-1 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  <MessageSquareText className="h-2.5 w-2.5 shrink-0" />
                                  <span className="truncate">{ev.label}</span>
                                </span>
                              ) : (
                                <span
                                  key={j}
                                  data-testid={`goal-evidence-unknown-${j}`}
                                  data-evidence-kind="unknown"
                                  className="inline-flex items-center gap-1 rounded border border-dashed border-foreground/20 px-1 py-0.5 text-[11px] text-muted-foreground/70"
                                >
                                  <AlertCircle className="h-2.5 w-2.5 shrink-0" />
                                  {t('goal.evidenceUnknown')}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {(verification.warning || verification.executionFactsNote || verification.error) && (
                  <div data-testid="goal-verification-notes" className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                    {verification.warning && <p>{t('goal.verificationWarning', { warning: verification.warning })}</p>}
                    {verification.executionFactsNote && <p>{verification.executionFactsNote}</p>}
                    {verification.error && <p>{t('goal.verificationError', { error: verification.error })}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
