import { useClientWorkbenchStyle, clientWorkbenchDialogClassName, clientWorkbenchOverlayClassName, clientWorkbenchPrimaryClassName, clientWorkbenchButtonClassName, clientWorkbenchDestructiveClassName } from '@/components/ui/client-workbench'
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
  const workbenchStyle = useClientWorkbenchStyle()
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
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={clientWorkbenchDialogClassName}
      >
        <DialogHeader>
          <DialogTitle data-testid="product-space-switch-title">
            {titleByPhase[pending.phase]}
          </DialogTitle>
          <DialogDescription>{descriptionByPhase[pending.phase]}</DialogDescription>
        </DialogHeader>
        <div className="px-[20px] pb-[18px]">

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
          <div>
            <div className="mb-[8px] mt-[18px] flex items-center justify-between text-[11px] text-foreground-60">
              <span data-testid="product-space-switch-progress-label">
                {t('productSpace.switch.stoppedCount', { stopped: stoppedCount, total: executions.length })}
              </span>
              <strong className="text-foreground" data-testid="product-space-switch-progress-percent">{percent}%</strong>
            </div>
            <div className="mb-[16px] h-[6px] w-full overflow-hidden rounded-full bg-foreground-10">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex max-h-[224px] flex-col overflow-y-auto rounded-[8px] border border-border" data-testid="product-space-switch-executions">
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
                    className="flex items-center justify-between gap-[10px] border-b border-border p-[11px] last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{execution.name}</span>
                    <span className="text-[10px] text-foreground-50">
                      {detailKey ? t(detailKey) : t(executionStatusKey(status))}
                    </span>
                    <span
                      className={
                        status === 'failed'
                          ? 'text-[10px] font-medium text-destructive'
                          : status === 'stopped'
                            ? 'text-[10px] font-medium text-success'
                            : 'text-[10px] font-medium text-info'
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

        <p className="mt-[11px] text-[11px] leading-[1.45] text-foreground-50" data-testid="product-space-switch-note">
          {t('productSpace.switch.currentSpaceNote', { name: currentName })}
        </p>

        </div>
        <DialogFooter>
          {pending.phase === 'confirm' ? (
            <>
              <Button
                type="button"
                className={clientWorkbenchButtonClassName}
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.switch.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className={clientWorkbenchDestructiveClassName}
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
                className={clientWorkbenchButtonClassName}
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.switch.cancel')}
              </Button>
              <Button className={clientWorkbenchPrimaryClassName} type="button" disabled data-testid="product-space-switch-busy">
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
                className={clientWorkbenchButtonClassName}
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.switch.cancel')}
              </Button>
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
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
                className={clientWorkbenchButtonClassName}
                variant="ghost"
                data-testid="product-space-cancel-switch"
                onClick={space.onCancelSwitch}
              >
                {t('productSpace.target.stay', { name: currentName })}
              </Button>
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
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
              className={clientWorkbenchPrimaryClassName}
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
