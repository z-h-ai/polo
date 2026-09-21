import { useCallback, useEffect, useReducer } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StatusPill } from '@/components/hifi'
import type { RuntimeTask } from './AppRuntimeTasksContext'

/**
 * 关闭三选项（P-M04-CLOSE-ACTIVE，D-PC-07 M04 收口）：
 * 取消 / 后台继续（普通操作）/ 停止并关闭（危险操作）。
 *
 * 停止失败进入 term-failed 态（P-M04-TERM-FAILED）：标签保留、只重试
 * 失败项、取消不复活已停止任务（C-R03：不出现「看似关了还在跑」）。
 */

export type AppCloseDialogPhase =
  | { kind: 'choose' }
  | { kind: 'terminating' }
  | { kind: 'failed'; failedTaskIds: string[] }

export type AppCloseDialogAction =
  | { type: 'terminate-started' }
  | { type: 'terminate-succeeded' }
  | { type: 'terminate-failed'; failedTaskIds: string[] }
  | { type: 'reset' }

export function appCloseDialogReducer(
  state: AppCloseDialogPhase,
  action: AppCloseDialogAction,
): AppCloseDialogPhase {
  switch (action.type) {
    case 'terminate-started':
      return { kind: 'terminating' }
    case 'terminate-succeeded':
      return { kind: 'choose' }
    case 'terminate-failed':
      return { kind: 'failed', failedTaskIds: action.failedTaskIds }
    case 'reset':
      return { kind: 'choose' }
  }
}

/** 终止后仍未停止的任务（failed 态只重试这些）。 */
export function selectFailedTasks(
  tasks: readonly RuntimeTask[],
  failedTaskIds: readonly string[],
): RuntimeTask[] {
  return tasks.filter(task => failedTaskIds.includes(task.id))
}

interface AppCloseDialogProps {
  open: boolean
  appName: string
  tasks: RuntimeTask[]
  onCancel: () => void
  /** 后台继续：立即关闭标签，任务保持运行。 */
  onBackgroundContinue: () => void
  /**
   * 停止传入的任务；resolve 为停止失败的子集（空数组 = 全部成功）。
   * 已停止的任务不会被再次传入（取消不复活已停止任务）。
   */
  onStopTasks: (tasks: RuntimeTask[]) => Promise<RuntimeTask[]>
  /** 全部停止成功后调用（调用方在此真正关闭标签）。 */
  onTerminateSucceeded: () => void
}

export function AppCloseDialog({
  open,
  appName,
  tasks,
  onCancel,
  onBackgroundContinue,
  onStopTasks,
  onTerminateSucceeded,
}: AppCloseDialogProps) {
  const { t } = useTranslation()
  const [phase, dispatch] = useReducer(appCloseDialogReducer, { kind: 'choose' })

  useEffect(() => {
    // 每次打开重置到三选项态；关闭时同样清理，避免残留 failed 态。
    dispatch({ type: 'reset' })
  }, [open])

  const runTerminate = useCallback(async (targets: RuntimeTask[]) => {
    dispatch({ type: 'terminate-started' })
    let failed: RuntimeTask[]
    try {
      failed = await onStopTasks(targets)
    } catch {
      failed = targets
    }
    if (failed.length === 0) {
      dispatch({ type: 'terminate-succeeded' })
      onTerminateSucceeded()
      return
    }
    dispatch({
      type: 'terminate-failed',
      failedTaskIds: failed.map(task => task.id),
    })
  }, [onStopTasks, onTerminateSucceeded])

  const failedTasks = phase.kind === 'failed'
    ? selectFailedTasks(tasks, phase.failedTaskIds)
    : []
  const terminating = phase.kind === 'terminating'

  const taskRows = (rows: RuntimeTask[]) => (
    <ul className="space-y-2" data-testid="close-dialog-tasks">
      {rows.map(task => (
        <li
          key={task.id}
          className="flex items-center gap-3 rounded-lg border border-foreground/10 bg-foreground/3 px-3 py-2"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-hifi-info-soft text-hifi-info">
            {task.kind === 'assistant'
              ? (
                <Icons.Sparkles
                  className="size-3.5"
                  strokeWidth={1.5}
                />
              )
              : <Icons.LayoutGrid className="size-3.5" strokeWidth={1.5} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {task.title}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {task.appName}
            </span>
          </span>
          <StatusPill tone="info">{t('appContainer.runtime.running')}</StatusPill>
        </li>
      ))}
    </ul>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent data-testid="app-close-dialog">
        {phase.kind === 'failed' ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('appContainer.close.termFailedTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('appContainer.close.termFailedDescription', {
                  name: appName,
                })}
              </DialogDescription>
            </DialogHeader>
            {taskRows(failedTasks)}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={onCancel}
              >
                {t('appContainer.close.backToApp')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  void runTerminate(failedTasks)
                }}
              >
                {t('appContainer.close.retryFailed')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('appContainer.close.title', { name: appName })}
              </DialogTitle>
              <DialogDescription>
                {t('appContainer.close.description', {
                  name: appName,
                  count: tasks.length,
                })}
              </DialogDescription>
            </DialogHeader>
            {taskRows(tasks)}
            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
              <Button
                type="button"
                variant="ghost"
                disabled={terminating}
                onClick={onCancel}
              >
                {t('common.cancel')}
              </Button>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  disabled={terminating}
                  onClick={onBackgroundContinue}
                >
                  {t('appContainer.close.background')}
                </Button>
                <p className="mt-1 text-center text-xs text-muted-foreground">
                  {t('appContainer.close.backgroundHint')}
                </p>
              </div>
              <div>
                <Button
                  type="button"
                  variant="destructive"
                  className="w-full"
                  disabled={terminating}
                  onClick={() => { void runTerminate(tasks) }}
                >
                  {terminating && (
                    <Icons.LoaderCircle
                      className="size-4 animate-spin"
                      strokeWidth={1.5}
                    />
                  )}
                  {terminating
                    ? t('appContainer.close.terminating')
                    : t('appContainer.close.terminate')}
                </Button>
                <p className="mt-1 text-center text-xs text-muted-foreground">
                  {t('appContainer.close.terminatingHint')}
                </p>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
