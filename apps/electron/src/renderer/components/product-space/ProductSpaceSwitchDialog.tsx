import { useTranslation } from 'react-i18next'
import type { ExecutionStatus } from '@polo-ai/shared/product-spaces'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'

function executionStatusKey(status: ExecutionStatus): string {
  return `productSpace.exec.status.${status}`
}

/**
 * The single safe switch transaction dialog. While any switch phase is open
 * the client stays inside the origin space: nothing from the target space can
 * appear until the transaction commits.
 */
export function ProductSpaceSwitchDialog() {
  const { t } = useTranslation()
  const space = useOptionalProductSpaceContext()
  const pending = space?.pendingSwitch ?? null
  const currentName = space?.activeProductSpace?.name ?? ''
  if (!space || !pending) return null

  const target = space.allProductSpaces.find(item => item.id === pending.targetId)
  const targetName = target?.name ?? ''
  const executions = pending.executions
  const stoppedCount = executions.filter(
    execution => pending.statuses[execution.executionId] === 'stopped',
  ).length
  const failedCount = executions.filter(
    execution => pending.statuses[execution.executionId] === 'failed',
  ).length
  const percent = executions.length === 0
    ? 100
    : Math.round((stoppedCount / executions.length) * 100)

  const titleByPhase: Record<typeof pending.phase, string> = {
    confirm: t('productSpace.switch.title', { name: targetName }),
    stopping: t('productSpace.switch.progressTitle'),
    'stop-failed': t('productSpace.switch.failedTitle'),
    'target-loading': t('productSpace.switch.preparingTitle'),
    'target-failed': t('productSpace.target.failedTitle', { name: targetName }),
    'target-access-lost': t('productSpace.target.accessLostTitle', { name: targetName }),
  }
  const descriptionByPhase: Record<typeof pending.phase, string> = {
    confirm: t('productSpace.switch.stopCount', { count: executions.length }),
    stopping: t('productSpace.switch.progressDesc', { name: targetName }),
    'stop-failed': t('productSpace.switch.failedDesc'),
    'target-loading': t('productSpace.switch.preparingDesc', { name: targetName }),
    'target-failed': t('productSpace.target.failedDesc'),
    'target-access-lost': t('productSpace.target.accessLostDesc'),
  }

  return (
    <Dialog open onOpenChange={open => {
      if (!open && (pending.phase === 'confirm' || pending.phase === 'stop-failed')) {
        space.onCancelSwitch()
      }
    }}>
      <DialogContent
        data-testid="product-space-switch-dialog"
        data-switch-phase={pending.phase}
        className="max-w-lg"
      >
        <DialogHeader>
          <DialogTitle data-testid="product-space-switch-title">
            {titleByPhase[pending.phase]}
          </DialogTitle>
          <DialogDescription>{descriptionByPhase[pending.phase]}</DialogDescription>
        </DialogHeader>

        {pending.phase === 'stop-failed' ? (
          <div
            role="alert"
            data-testid="product-space-switch-failed-alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t('productSpace.switch.failedNotice', { count: failedCount })}
          </div>
        ) : null}

        {pending.phase === 'target-failed' || pending.phase === 'target-access-lost' ? (
          <div
            data-testid="product-space-switch-impact"
            className="rounded-lg border border-border/50 bg-foreground/5 px-3 py-2 text-sm"
          >
            <strong className="block">
              {pending.phase === 'target-failed'
                ? t('productSpace.target.loadFailedLabel')
                : t('productSpace.target.removedLabel')}
            </strong>
            <span className="text-muted-foreground">
              {pending.phase === 'target-failed'
                ? t('productSpace.target.loadFailedHint', { name: currentName })
                : t('productSpace.target.removedHint', { name: currentName })}
            </span>
          </div>
        ) : null}

        {executions.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span data-testid="product-space-switch-progress-label">
                {t('productSpace.switch.stoppedCount', { stopped: stoppedCount, total: executions.length })}
              </span>
              <strong data-testid="product-space-switch-progress-percent">{percent}%</strong>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-foreground/70 transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto" data-testid="product-space-switch-executions">
              {executions.map(execution => {
                const status = pending.statuses[execution.executionId] ?? execution.status
                const detailKey = status === 'failed'
                  ? 'productSpace.exec.item.failed'
                  : status === 'stopped'
                    ? 'productSpace.exec.item.stopped'
                    : status === 'stopping'
                      ? 'productSpace.exec.item.stopping'
                      : null
                const stoppable = pending.phase === 'stopping'
                  && status !== 'stopped'
                  && status !== 'failed'
                  && status !== 'stopping'
                return (
                  <div
                    key={execution.executionId}
                    data-testid="product-space-switch-execution-row"
                    data-execution-status={status}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/40 px-2.5 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{execution.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {detailKey ? t(detailKey) : t(executionStatusKey(status))}
                    </span>
                    <span
                      className={
                        status === 'failed'
                          ? 'text-xs font-medium text-destructive'
                          : status === 'stopped'
                            ? 'text-xs font-medium text-success'
                            : 'text-xs font-medium text-info'
                      }
                    >
                      {status === 'failed'
                        ? t('productSpace.exec.status.failed')
                        : t(executionStatusKey(status))}
                    </span>
                    {stoppable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        data-testid="product-space-switch-execution-stop"
                        onClick={() => space.onStopSwitchExecution(execution.executionId)}
                      >
                        {t('productSpace.exec.stopAction')}
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground" data-testid="product-space-switch-note">
          {t('productSpace.switch.currentSpaceNote', { name: currentName })}
        </p>

        <DialogFooter>
          {pending.phase === 'confirm' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.switch.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                data-testid="product-space-stop-and-switch"
                onClick={space.onConfirmStopAndSwitch}
              >
                {t('productSpace.switch.stopAndSwitch')}
              </Button>
            </>
          ) : null}
          {pending.phase === 'stopping' || pending.phase === 'target-loading' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.switch.cancel')}
              </Button>
              <Button type="button" disabled data-testid="product-space-switch-busy">
                {pending.phase === 'stopping'
                  ? t('productSpace.switch.stopping')
                  : t('productSpace.switch.preparing')}
              </Button>
            </>
          ) : null}
          {pending.phase === 'stop-failed' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.switch.cancel')}
              </Button>
              <Button
                type="button"
                data-testid="product-space-retry-failed"
                onClick={space.onRetryFailedStops}
              >
                {t('productSpace.switch.retryFailed')}
              </Button>
            </>
          ) : null}
          {pending.phase === 'target-failed' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.target.stay', { name: currentName })}
              </Button>
              <Button
                type="button"
                data-testid="product-space-retry-target-load"
                onClick={space.onRetryTargetLoad}
              >
                {t('productSpace.target.retry')}
              </Button>
            </>
          ) : null}
          {pending.phase === 'target-access-lost' ? (
            <Button
              type="button"
              data-testid="product-space-cancel-switch"
              onClick={space.onDismissTargetAccessLost}
            >
              {t('productSpace.target.stay', { name: currentName })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
