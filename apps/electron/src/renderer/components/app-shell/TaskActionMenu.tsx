import * as React from 'react'
import { useTranslation } from "react-i18next"
import { ChevronDown, Square, ArrowUpRight } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { Spinner } from '@polo-ai/ui'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { BackgroundTask } from './ActiveTasksBar'

/** Terminal data for overlay display */
export interface TerminalOverlayData {
  command: string
  output: string
  description?: string
  toolType: 'bash' | 'grep' | 'glob'
}

/** Format elapsed time in a compact way */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/** Shorten task ID for compact display (show first 8 chars) */
function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id
}

export interface TaskActionMenuProps {
  /** Background task data */
  task: BackgroundTask
  /** Session ID for opening preview windows */
  sessionId: string
  /** Callback when kill button is clicked */
  onKillTask: (taskId: string) => void
  /** Callback to insert message into input field */
  onInsertMessage?: (text: string) => void
  /** Callback to show terminal output overlay */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** Additional class name */
  className?: string
}

/**
 * TaskActionMenu - Dropdown menu for background task actions
 *
 * Provides contextual actions for background tasks:
 * - View Output: Opens task output in terminal overlay
 * - Stop Task: Kills shell tasks via IPC (disabled for agent tasks - no kill channel yet)
 */
export function TaskActionMenu({ task, sessionId, onKillTask, onInsertMessage, onShowTerminalOverlay, className }: TaskActionMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  // Local timer for shell tasks (since they don't get task_progress events)
  // For agent tasks, we use elapsedSeconds from events
  const [localElapsed, setLocalElapsed] = React.useState(() => {
    // Initialize from startTime
    return Math.floor((Date.now() - task.startTime) / 1000)
  })

  React.useEffect(() => {
    // Only use local timer for shell tasks
    if (task.type !== 'shell') return

    const interval = setInterval(() => {
      setLocalElapsed(Math.floor((Date.now() - task.startTime) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [task.type, task.startTime])

  // Use local timer for shells, event-based for agents
  const displayElapsed = task.type === 'shell' ? localElapsed : task.elapsedSeconds

  const handleViewOutput = async () => {
    if (!onShowTerminalOverlay) {
      toast.error(t('toast.terminalOverlayNotAvailable'))
      return
    }

    try {
      // Fetch task output via IPC
      const output = await window.electronAPI.getTaskOutput(task.id)

      // Show terminal output in overlay
      onShowTerminalOverlay({
        command: task.intent || `${task.type} task`,
        output: output || t('chat.noOutputYet'),
        description: task.intent,
        toolType: 'bash', // Use 'bash' for both shell and agent tasks
      })
      setOpen(false)
    } catch (err) {
      toast.error(t('toast.failedToLoadTaskOutput'))
    }
  }

  const handleStopTask = () => {
    // No kill channel for background agents yet - the menu item is disabled,
    // but guard here as well so the click can never reach onKillTask.
    if (task.type === 'agent') return
    onKillTask(task.id)
    setOpen(false)
  }


  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px]",
            "flex items-center gap-1.5 shrink-0 select-none",
            "transition-all shadow-minimal cursor-pointer",
            // Plain white badge with hover
            "bg-white dark:bg-white/10",
            "hover:bg-white/80 dark:hover:bg-white/15",
            "data-[state=open]:bg-white/80 dark:data-[state=open]:bg-white/15",
            className
          )}
          title={t("chat.clickForTaskActions")}
        >
          {/* Spinner */}
          <div className="flex items-center justify-center shrink-0">
            <Spinner className="text-xs" />
          </div>

          {/* Type badge */}
          <span className="opacity-60">
            {task.type === 'agent' ? t('chat.taskTypeAgent') : t('chat.taskTypeShell')}
          </span>

          {/* Task ID (shortened) */}
          <span className="font-mono opacity-80">
            {shortenId(task.id)}
          </span>

          {/* Elapsed time */}
          <span className="opacity-60 tabular-nums">
            {formatElapsed(displayElapsed)}
          </span>

          {/* Dropdown indicator */}
          <ChevronDown className="h-3.5 w-3.5 opacity-60 ml-auto" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" sideOffset={4}>
        {/* View Output - Primary action */}
        <StyledDropdownMenuItem onClick={handleViewOutput}>
          <ArrowUpRight />
          {t('chat.viewOutput')}
        </StyledDropdownMenuItem>

        {/* Stop Task - shells are killed via IPC; agent tasks have no kill
            channel yet, so the item stays visible but disabled with a reason. */}
        <StyledDropdownMenuSeparator />
        <StyledDropdownMenuItem
          onClick={handleStopTask}
          disabled={task.type === 'agent'}
          title={task.type === 'agent' ? t('toast.cannotStopAgentTask') : undefined}
          className={
            // Keep hover events so the title tooltip can show on the disabled item
            task.type === 'agent' ? 'data-[disabled]:pointer-events-auto' : undefined
          }
        >
          <Square />
          {t('chat.stopTask')}
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
