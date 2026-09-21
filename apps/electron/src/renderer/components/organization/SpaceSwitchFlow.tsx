import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { RunningActivitiesPanel } from './RunningActivitiesPanel'
import { useSpaceSwitchFlow } from './useSpaceSwitchFlow'

type FlowButtonVariant = 'default' | 'primary' | 'danger'

interface FlowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: FlowButtonVariant
  /** g4 `.spinner` — rotating glyph inside disabled in-progress buttons. */
  spinning?: boolean
}

/** g4 `.button` on the hifi tokens (default / primary / danger). */
function FlowButton({
  variant = 'default',
  spinning = false,
  className,
  disabled,
  children,
  ...props
}: FlowButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-hifi-md border px-3 text-hifi-base font-medium transition-colors',
        'border-hifi-border bg-transparent text-hifi-foreground hover:bg-hifi-fg-5',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        variant === 'primary' &&
          'cursor-pointer border-hifi-accent bg-hifi-accent text-hifi-on-accent hover:bg-hifi-accent',
        variant === 'danger' &&
          'cursor-pointer border-hifi-destructive bg-hifi-destructive text-white hover:bg-hifi-destructive',
        className,
      )}
      {...props}
    >
      {spinning && (
        <span
          aria-hidden="true"
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  )
}

/** g4 `.switch-progress-summary` + `.progress-track`. */
function StopProgress({
  label,
  percent,
}: {
  label: React.ReactNode
  percent?: number
}) {
  const width = percent == null ? null : Math.max(0, Math.min(100, percent))
  return (
    <>
      <div className="mt-[18px] mb-2 flex justify-between text-hifi-sm text-hifi-fg-60">
        <span>{label}</span>
        {width != null && (
          <strong className="font-medium text-hifi-foreground">{width}%</strong>
        )}
      </div>
      <div className="mb-4 h-[6px] overflow-hidden rounded-hifi-pill bg-hifi-fg-10">
        <span
          className="block h-full rounded-[inherit] bg-hifi-accent"
          style={{
            width: `${width ?? 0}%`,
            transition: 'width var(--hifi-transition-state)',
          }}
        />
      </div>
    </>
  )
}

/** g4 `.inline-alert.bad` — destructive soft note with a leading dot. */
function InlineAlert({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-[18px] grid grid-cols-[8px_minmax(0,1fr)] gap-[9px] rounded-hifi-md bg-hifi-destructive-soft px-3 py-[11px] text-left text-hifi-base leading-[1.45] text-hifi-fg-70"
    >
      <i
        aria-hidden="true"
        className="mt-[5px] block size-[6px] rounded-full bg-hifi-destructive"
      />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/** g4 `.dialog-note`. */
function DialogNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mt-[11px] text-hifi-sm leading-[1.45] text-hifi-fg-50">{children}</p>
  )
}

/** g4 `.state-facts` (access-lost explanation). */
function FactList({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl className="m-0 grid overflow-hidden rounded-hifi-md border border-hifi-border text-left">
      {facts.map((fact) => (
        <div
          key={fact.label}
          className="grid grid-cols-[116px_minmax(0,1fr)] gap-3 border-b border-hifi-border px-[13px] py-[11px] text-hifi-base last:border-b-0"
        >
          <dt className="text-hifi-fg-50">{fact.label}</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface SwitchDialogProps {
  title: string
  subtitle: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}

/** g4 `.dialog.switch-dialog` chrome: header + close, body, footer. */
function SwitchDialogShell({ title, subtitle, onClose, children, footer }: SwitchDialogProps) {
  const { t } = useTranslation()
  return (
    <DialogPrimitive.Content
      data-testid="space-switch-dialog"
      className="fixed left-1/2 top-1/2 z-modal grid w-[min(620px,calc(100%-2.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-hifi-edge border border-hifi-border bg-hifi-surface shadow-modal-small outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
    >
      <div className="flex items-start justify-between gap-4 px-5 pb-[14px] pt-5">
        <div>
          <DialogPrimitive.Title asChild>
            <h2 className="m-0 text-hifi-2xl leading-[1.35] font-semibold tracking-[-0.035em] text-hifi-foreground">
              {title}
            </h2>
          </DialogPrimitive.Title>
          <DialogPrimitive.Description asChild>
            <p className="mb-0 mt-[6px] text-hifi-md leading-[1.5] text-hifi-fg-60">{subtitle}</p>
          </DialogPrimitive.Description>
        </div>
        <button
          type="button"
          aria-label={t('spaceSwitch.dialog.close')}
          onClick={onClose}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-hifi-sm bg-transparent text-hifi-fg-50 hover:bg-hifi-fg-5 hover:text-hifi-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="px-5 pb-[18px]">{children}</div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-hifi-border px-5 py-[13px]">
        {footer}
      </div>
    </DialogPrimitive.Content>
  )
}

/**
 * SpaceSwitchFlow — the space-switch transaction dialog (prototype M02).
 * Renders nothing while idle/done; every other phase is the g4
 * `.switch-dialog` over the `.modal-layer` overlay. Mounted once inside
 * `SpaceSwitchFlowProvider` (or beside it) at the app shell root.
 */
export function SpaceSwitchFlow() {
  const { t } = useTranslation()
  const flow = useSpaceSwitchFlow()
  const { phase, target, activities, currentSpaceName, stoppedCount } = flow
  const total = activities.length
  const failedCount = activities.filter((entry) => entry.status === 'failed').length
  const percent = total > 0 ? Math.round((stoppedCount / total) * 100) : null
  const targetName = target?.name ?? ''

  // X / Esc / overlay click: same semantics as the phase's secondary action.
  const requestClose = () => {
    if (phase === 'stopCancel' || phase === 'accessLost') {
      flow.dismiss()
    } else if (phase === 'targetFailed') {
      flow.stayInCurrentSpace()
    } else {
      flow.cancelSwitch()
    }
  }

  const open = phase !== 'idle' && phase !== 'done'

  let dialog: React.ReactNode = null
  if (phase === 'confirm') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.confirm.title', { name: targetName })}
        subtitle={t('spaceSwitch.confirm.subtitle', { total })}
        onClose={requestClose}
        footer={
          <>
            <FlowButton onClick={flow.cancelSwitch}>{t('spaceSwitch.confirm.cancel')}</FlowButton>
            <FlowButton variant="danger" onClick={flow.confirmStop}>
              {t('spaceSwitch.confirm.stopAll')}
            </FlowButton>
          </>
        }
      >
        <RunningActivitiesPanel items={activities} />
        <DialogNote>{t('spaceSwitch.confirm.note', { name: currentSpaceName })}</DialogNote>
      </SwitchDialogShell>
    )
  } else if (phase === 'stopping') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.stopping.title')}
        subtitle={t('spaceSwitch.stopping.subtitle')}
        onClose={requestClose}
        footer={
          <>
            <FlowButton onClick={flow.cancelSwitch}>{t('spaceSwitch.stopping.cancel')}</FlowButton>
            <FlowButton variant="primary" disabled spinning>
              {t('spaceSwitch.stopping.inProgress')}
            </FlowButton>
          </>
        }
      >
        <StopProgress label={t('spaceSwitch.stopping.summary', { total })} />
        <RunningActivitiesPanel items={activities} />
      </SwitchDialogShell>
    )
  } else if (phase === 'stopFailed') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.stopFailed.title')}
        subtitle={t('spaceSwitch.stopFailed.subtitle')}
        onClose={requestClose}
        footer={
          <>
            <FlowButton onClick={flow.cancelSwitch}>{t('spaceSwitch.stopFailed.cancel')}</FlowButton>
            <FlowButton variant="primary" onClick={flow.retryFailedStops}>
              {t('spaceSwitch.stopFailed.retry')}
            </FlowButton>
          </>
        }
      >
        <StopProgress
          label={t('spaceSwitch.progress.stoppedRatio', { stopped: stoppedCount, total })}
          percent={percent ?? undefined}
        />
        <InlineAlert>{t('spaceSwitch.stopFailed.alert', { failed: failedCount })}</InlineAlert>
        <RunningActivitiesPanel items={activities} className="mt-4" />
      </SwitchDialogShell>
    )
  } else if (phase === 'stopCancel') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.stopCancel.title')}
        subtitle={t('spaceSwitch.stopCancel.subtitle', { name: currentSpaceName })}
        onClose={requestClose}
        footer={
          <>
            <FlowButton onClick={flow.dismiss}>{t('spaceSwitch.stopCancel.backHome')}</FlowButton>
            <FlowButton variant="primary" onClick={flow.dismiss}>
              {t('spaceSwitch.stopCancel.reselect')}
            </FlowButton>
          </>
        }
      >
        {total > 0 && (
          <StopProgress
            label={t('spaceSwitch.progress.stoppedRatio', { stopped: stoppedCount, total })}
            percent={percent ?? undefined}
          />
        )}
        <RunningActivitiesPanel items={activities} />
        <DialogNote>{t('spaceSwitch.stopCancel.note')}</DialogNote>
      </SwitchDialogShell>
    )
  } else if (phase === 'targetLoading') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.targetLoading.title', { name: targetName })}
        subtitle={t('spaceSwitch.targetLoading.subtitle')}
        onClose={requestClose}
        footer={
          <>
            <FlowButton variant="primary" disabled spinning>
              {t('spaceSwitch.targetLoading.loading')}
            </FlowButton>
            <FlowButton disabled>{t('spaceSwitch.targetLoading.preparing')}</FlowButton>
          </>
        }
      >
        {total > 0 && (
          <StopProgress
            label={t('spaceSwitch.targetLoading.summary', { stopped: stoppedCount, total })}
            percent={percent ?? undefined}
          />
        )}
        <RunningActivitiesPanel items={activities} />
      </SwitchDialogShell>
    )
  } else if (phase === 'targetFailed') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.targetFailed.title', { name: targetName })}
        subtitle={t('spaceSwitch.targetFailed.subtitle')}
        onClose={requestClose}
        footer={
          <>
            <FlowButton onClick={flow.stayInCurrentSpace}>
              {t('spaceSwitch.targetFailed.stay', { name: currentSpaceName })}
            </FlowButton>
            <FlowButton variant="primary" onClick={flow.retryLoad}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t('spaceSwitch.targetFailed.retry')}
            </FlowButton>
          </>
        }
      >
        <InlineAlert>
          {t('spaceSwitch.targetFailed.alert', { name: currentSpaceName })}
        </InlineAlert>
      </SwitchDialogShell>
    )
  } else if (phase === 'accessLost') {
    dialog = (
      <SwitchDialogShell
        title={t('spaceSwitch.accessLost.title', { name: targetName })}
        subtitle={t('spaceSwitch.accessLost.subtitle')}
        onClose={requestClose}
        footer={
          <FlowButton onClick={flow.dismiss}>{t('spaceSwitch.accessLost.acknowledge')}</FlowButton>
        }
      >
        <FactList
          facts={[
            {
              label: t('spaceSwitch.accessLost.reason'),
              value: t('spaceSwitch.accessLost.reasonRemoved'),
            },
            {
              label: t('spaceSwitch.accessLost.currentSpace'),
              value: t('spaceSwitch.accessLost.currentSpaceValue', { name: currentSpaceName }),
            },
            {
              label: t('spaceSwitch.accessLost.recovery'),
              value: t('spaceSwitch.accessLost.recoveryContactAdmin'),
            },
          ]}
        />
      </SwitchDialogShell>
    )
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) requestClose() }}>
      {open && (
        <>
          <DialogPrimitive.Overlay className="fixed inset-0 z-modal bg-hifi-overlay duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          {dialog}
        </>
      )}
    </DialogPrimitive.Root>
  )
}
