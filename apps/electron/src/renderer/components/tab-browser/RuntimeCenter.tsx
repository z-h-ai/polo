import { useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/hifi'
import { cn } from '@/lib/utils'
import type { RuntimeTask } from './AppRuntimeTasksContext'

/**
 * 运行状态中心（P-M04-RUNTIME / -PERSONAL）。
 *
 * 按空间列出运行项：App 任务 + 助手生成；支持进入、逐项停止（C-R03）。
 * 组件自身可独立渲染（demo / 顶栏 pill 弹层）。
 */

interface RuntimeCenterProps {
  tasks: RuntimeTask[]
  onStopTask: (taskId: string) => Promise<void>
  onOpenTask?: (task: RuntimeTask) => void
  onClose?: () => void
  className?: string
}

interface RuntimeSpaceGroup {
  spaceId: string
  spaceName: string
  tasks: RuntimeTask[]
}

export function groupRuntimeTasksBySpace(
  tasks: readonly RuntimeTask[],
): RuntimeSpaceGroup[] {
  const groups = new Map<string, RuntimeSpaceGroup>()
  for (const task of tasks) {
    const existing = groups.get(task.spaceId)
    if (existing) {
      existing.tasks.push(task)
      continue
    }
    groups.set(task.spaceId, {
      spaceId: task.spaceId,
      spaceName: task.spaceName,
      tasks: [task],
    })
  }
  return [...groups.values()]
}

function TaskRow({
  task,
  onOpenTask,
  onStopTask,
}: {
  task: RuntimeTask
  onOpenTask?: (task: RuntimeTask) => void
  onStopTask: (taskId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [stopping, setStopping] = useState(false)
  const handleStop = async () => {
    setStopping(true)
    try {
      await onStopTask(task.id)
    } catch {
      toast.error(t('appContainer.runtime.stopFailed'))
    } finally {
      setStopping(false)
    }
  }
  return (
    <li
      data-testid={`runtime-task-${task.id}`}
      className="flex items-center gap-3 rounded-lg border border-hifi-border bg-hifi-surface px-3 py-2"
    >
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-hifi-sm',
          task.kind === 'assistant'
            ? 'bg-hifi-accent-soft text-hifi-accent'
            : 'bg-hifi-info-soft text-hifi-info',
        )}
      >
        {task.kind === 'assistant'
          ? (
            <Icons.Sparkles
              className="size-4"
              strokeWidth={1.5}
            />
          )
          : <Icons.LayoutGrid className="size-4" strokeWidth={1.5} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-hifi-md font-medium text-hifi-foreground">
          {task.title}
        </span>
        <span className="block truncate text-hifi-sm text-hifi-fg-50">
          {task.kind === 'assistant'
            ? t('appContainer.runtime.assistantTask', { name: task.appName })
            : t('appContainer.runtime.appTask', { name: task.appName })}
        </span>
      </span>
      <StatusPill tone={task.state === 'stopping' ? 'neutral' : 'info'}>
        {task.state === 'stopping'
          ? t('appContainer.runtime.stopping')
          : t('appContainer.runtime.running')}
      </StatusPill>
      <span className="flex shrink-0 items-center gap-1">
        {onOpenTask && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenTask(task)}
          >
            {t('appContainer.runtime.open')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={task.state !== 'running' || stopping}
          onClick={() => { void handleStop() }}
        >
          {stopping
            ? (
              <Icons.LoaderCircle
                className="size-4 animate-spin"
                strokeWidth={1.5}
              />
            )
            : t('appContainer.runtime.stop')}
        </Button>
      </span>
    </li>
  )
}

export function RuntimeCenter({
  tasks,
  onStopTask,
  onOpenTask,
  onClose,
  className,
}: RuntimeCenterProps) {
  const { t } = useTranslation()
  const groups = useMemo(
    () => groupRuntimeTasksBySpace(tasks),
    [tasks],
  )

  return (
    <section
      data-testid="runtime-center"
      className={cn(
        'w-[min(420px,100vw-24px)] rounded-hifi-lg border border-hifi-border bg-hifi-background p-4 shadow-middle',
        className,
      )}
      aria-labelledby="runtime-center-heading"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2
          id="runtime-center-heading"
          className="m-0 text-hifi-lg font-semibold text-hifi-foreground"
        >
          {t('appContainer.runtime.title')}
        </h2>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 rounded-md"
            aria-label={t('homeApps.inspector.close')}
            onClick={onClose}
          >
            <Icons.X className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        )}
      </header>
      {groups.length === 0 ? (
        <p className="rounded-hifi-md border border-dashed border-hifi-border px-4 py-6 text-center text-hifi-md text-hifi-fg-50">
          {t('appContainer.runtime.empty')}
        </p>
      ) : (
        <div className="max-h-[420px] space-y-4 overflow-y-auto">
          {groups.map(group => (
            <div key={group.spaceId} data-testid={`runtime-space-${group.spaceId}`}>
              <h3 className="mb-2 text-hifi-sm font-medium uppercase tracking-[0.75px] text-hifi-fg-50">
                {group.spaceName}
              </h3>
              <ul className="space-y-2">
                {group.tasks.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpenTask={onOpenTask}
                    onStopTask={onStopTask}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
