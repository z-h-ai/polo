/**
 * useBackgroundTasks - Hook for managing active background tasks
 *
 * Tracks background agents and shells per session.
 * Updated via event handlers for task_backgrounded, shell_backgrounded, task_progress.
 */

import { useAtom } from 'jotai'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'

export interface UseBackgroundTasksOptions {
  /** Session ID to track tasks for */
  sessionId: string
}

export interface UseBackgroundTasksResult {
  /** Active background tasks for this session */
  tasks: BackgroundTask[]
  /** Add a new background task */
  addTask: (task: Omit<BackgroundTask, 'elapsedSeconds'>) => void
  /** Update elapsed time for a task */
  updateTaskProgress: (toolUseId: string, elapsedSeconds: number) => void
  /** Remove a task (when completed or killed) */
  removeTask: (toolUseId: string) => void
  /** Kill a shell task (sends kill request via IPC). Agent tasks have no kill
   *  channel yet - they stay running and the user is notified via toast. */
  killTask: (taskId: string, type: 'agent' | 'shell') => Promise<void>
}

/**
 * Hook for managing background tasks in a session
 */
export function useBackgroundTasks({ sessionId }: UseBackgroundTasksOptions): UseBackgroundTasksResult {
  const [tasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId))
  const { t } = useTranslation()

  const addTask = useCallback((task: Omit<BackgroundTask, 'elapsedSeconds'>) => {
    setTasks(prev => {
      // Check if task already exists (prevent duplicates)
      if (prev.some(t => t.toolUseId === task.toolUseId)) {
        return prev
      }
      // Add new task with 0 elapsed seconds
      return [...prev, { ...task, elapsedSeconds: 0 }]
    })
  }, [setTasks])

  const updateTaskProgress = useCallback((toolUseId: string, elapsedSeconds: number) => {
    setTasks(prev => prev.map(t =>
      t.toolUseId === toolUseId
        ? { ...t, elapsedSeconds }
        : t
    ))
  }, [setTasks])

  const removeTask = useCallback((toolUseId: string) => {
    setTasks(prev => prev.filter(t => t.toolUseId !== toolUseId))
  }, [setTasks])

  const killTask = useCallback(async (taskId: string, type: 'agent' | 'shell') => {
    if (type !== 'shell') {
      // There is no kill channel for background agents yet. Keep the task
      // running and visible instead of silently dropping it from the UI.
      toast.error(t('toast.cannotStopAgentTask'))
      return
    }

    // Find the task to remove it from the UI after the kill request
    const task = tasks.find(entry => entry.id === taskId)

    // Use KillShell IPC for shells
    try {
      await window.electronAPI.killShell(sessionId, taskId)
    } catch {
      // Shell may already be gone - that's OK, still remove from UI
    }

    // Remove from UI after kill attempt (shell tasks only)
    if (task) {
      setTasks(prev => prev.filter(entry => entry.id !== taskId))
    }
  }, [sessionId, tasks, setTasks, t])

  return {
    tasks,
    addTask,
    updateTaskProgress,
    removeTask,
    killTask,
  }
}
