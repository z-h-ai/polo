/**
 * TopupCheckFlow — the return-from-browser check (POO-70 M09).
 *
 * CHECKING: one query in flight; the conversation and draft stay put.
 * NOT-YET: the block stays and 再查一次 is another user-initiated check.
 * RESUMED: the arrival only lifts the block — 继续发送 stays a separate
 * user action, rendered here as the resumed banner.
 */

import { CircleAlert, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FlowButton } from '@/components/tab-browser/circles/flowButtons'
import { CreditsGate } from './CreditsGate'

export type TopupCheckPhase = 'checking' | 'not-arrived' | 'resumed'

export interface TopupCheckFlowProps {
  phase: TopupCheckPhase
  /** Balance snapshot for the resumed banner. */
  balance?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 查看结果 / 再查一次 — settles the current query or starts a new one. */
  onCheck: () => void
  /** 继续发送 — explicit user action after arrival. */
  onContinueSend?: () => void
}

export function TopupCheckFlow({
  phase,
  balance = 0,
  open,
  onOpenChange,
  onCheck,
  onContinueSend,
}: TopupCheckFlowProps) {
  const { t } = useTranslation()

  if (phase === 'resumed') {
    return (
      <div data-testid="topup-check-resumed" className="w-full max-w-[720px] p-4">
        <CreditsGate
          variant="resumed"
          needed={0}
          balance={balance}
          onContinueSend={onContinueSend}
        />
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[440px]"
        data-testid={`topup-check-${phase}`}
      >
        {phase === 'checking' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('credits.check.checkingTitle')}</DialogTitle>
              <DialogDescription>
                {t('credits.check.checkingNote')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-3 rounded-hifi-md border border-hifi-border bg-hifi-surface p-4 text-left">
              <span
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin rounded-full border-2 border-hifi-fg-20 border-t-hifi-info"
              />
              <span className="text-hifi-base text-hifi-foreground">
                {t('credits.check.checkingBody')}
              </span>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <FlowButton variant="primary" onClick={onCheck}>
                {t('credits.check.viewResult')}
              </FlowButton>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('credits.check.notYetTitle')}</DialogTitle>
              <DialogDescription>{t('credits.check.notYetSubtitle')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2.5 text-left">
              <div className="flex items-start gap-2.5 rounded-hifi-md border border-hifi-border bg-hifi-destructive-soft p-3.5">
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0 text-hifi-destructive"
                  aria-hidden="true"
                />
                <span className="text-hifi-base text-hifi-foreground">
                  {t('credits.check.notYetAlert')}
                </span>
              </div>
              <p className="m-0 text-hifi-base text-hifi-fg-60">
                {t('credits.check.notYetNote')}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <FlowButton variant="quiet" onClick={() => onOpenChange(false)}>
                {t('credits.check.later')}
              </FlowButton>
              <FlowButton variant="primary" onClick={onCheck}>
                <RotateCw className="size-3.5" aria-hidden="true" />
                {t('credits.check.recheck')}
              </FlowButton>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
