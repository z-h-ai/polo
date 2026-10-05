import { useCallback, useRef } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useRegisterModal } from '@/context/ModalContext'
import { useClientWorkbenchStyle, clientWorkbenchDialogClassName, clientWorkbenchOverlayClassName } from '@/components/ui/client-workbench'
import { useTranslation } from 'react-i18next'
import type { LeaveCircleDialogState } from '@/hooks/useLeaveCircle'

/**
 * Leave-circle confirmation dialog (POO-70 C7 / POO-96; P70-LEAVE-01/02/03).
 *
 * 交接接口 (exact card handoff): `LeaveCircleDialog({state, onConfirm,
 * onCancel})`. The ONLY consumer is the circle-detail SUBSCRIPTION section —
 * the content/updates headers render no exit control anywhere (Spec §13.12/
 * §13.13: 退出仅放订阅区域). The component is a pure projection of `state`
 * (built by `useLeaveCircle`): it holds no flow state of its own, issues no
 * read/write, and never decides outcomes — clicking 确认退出 IS the single
 * confirmation; every other decision lives in the hook and the contracts
 * behind it.
 *
 * Presentation per the confirmed dialog contract (design-system 确认对话框:
 * edge radius + panel shadow; prototype scenes P-M07-LEAVE /
 * P-M07-LEAVE-PAID / P-M07-LEAVE-DATA / P-M07-LEAVE-YEAR):
 * - 原对象明确: the circle name is in the title, the per-source impact is in
 *   the body — the caller-provided `lastSourceWorkNames` (an H1 fact) renders
 *   the "last valid source" wording; nothing is computed or guessed here.
 * - busy: the confirm button is disabled while the write or the read-only
 *   re-verification runs (双击防重 is enforced by the hook; this disables the
 *   affordance too).
 * - 失败: an explicit error banner replaces nothing — the dialog stays open
 *   with the fact that the relation is unchanged.
 * - 结果未知 (recheck): the body explains the read-only re-verification; the
 *   confirm button stays disabled (no rewrite path exists from this dialog),
 *   cancel remains available.
 * - suspended: the F1 suspended relation is NOT a departure — the dialog
 *   says so explicitly instead of ever presenting 已退出 or a rejoin.
 *
 * Radix contains keyboard focus and restores the original entry on close.
 * Escape, outside dismissal and the modal registry all use the same busy
 * cancel guard; the hook retains its own single-write protection.
 */
export function LeaveCircleDialog({
  state,
  onConfirm,
  onCancel,
}: {
  state: LeaveCircleDialogState | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()

  const workbenchStyle = useClientWorkbenchStyle()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const confirming = Boolean(state?.busy && state.phase === 'confirm')
  const cancel = useCallback(() => {
    if (!confirming) onCancel()
  }, [confirming, onCancel])
  useRegisterModal(Boolean(state), cancel)

  if (!state) return null

  const rechecking = state.phase === 'recheck'
  // The confirm button is the single write per attempt: enabled in `confirm`
  // and as the deliberate retry after an honest `error`; never during `busy`
  // and never in `recheck` (no rewrite path exists from a recheck). A
  // suspended relation cannot be left at all (F1: status ≠ active → 409),
  // so the retry affordance is disabled for that failure kind.
  const confirmDisabled = state.busy
    || (state.phase !== 'confirm' && state.phase !== 'error')
    || state.failure?.kind === 'suspended'
  // The write must land truthfully before the dialog may close — cancel is
  // disabled while the confirm write is in flight (the hook refuses it too).
  const cancelDisabled = confirming

  return (
    <Dialog open onOpenChange={open => { if (!open) cancel() }}>
      <DialogContent
        data-testid="leave-circle-dialog"
        data-circle-id={state.circleId}
        data-phase={state.phase}
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        showCloseButton={false}
        className={clientWorkbenchDialogClassName}
        onOpenAutoFocus={event => {
          event.preventDefault()
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          cancelRef.current?.focus()
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
        }}
        onEscapeKeyDown={event => { event.preventDefault(); cancel() }}
        onInteractOutside={event => { event.preventDefault(); cancel() }}
      >
        <div className="flex items-start justify-between gap-[16px] px-[20px] pb-[14px] pt-[20px]">
          <div>
            <DialogTitle
              data-testid="leave-circle-dialog-title"
              className="m-0 text-[16px] font-semibold leading-[1.4] text-foreground"
            >
              {t('poo70.c7.dialog.title', { name: state.circleName })}
            </DialogTitle>
            <DialogDescription className="m-[6px_0_0] text-[13px] leading-[1.5] text-foreground-60" data-testid="leave-circle-dialog-subtitle">
              {t('poo70.c7.dialog.subtitle')}
            </DialogDescription>
          </div>
        </div>

        <div className="px-[20px] pb-[18px]" data-testid="leave-circle-dialog-body">
          {rechecking ? (
            <div
              className="rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
              role="status"
              data-testid="leave-circle-dialog-recheck"
            >
              <p className="m-0 font-medium">{t('poo70.c7.dialog.recheckTitle')}</p>
              <p className="m-[4px_0_0]">
                {state.recheckUnresolved
                  ? t('poo70.c7.dialog.recheckUnresolved')
                  : t('poo70.c7.dialog.recheckBody')}
              </p>
            </div>
          ) : (
            <>
              {state.failure && (
                <div
                  className="mb-[10px] rounded-[13px] border border-destructive/25 bg-destructive/8 px-4 py-3 text-xs text-destructive"
                  role="alert"
                  data-testid="leave-circle-dialog-error"
                >
                  <p className="m-0 font-medium">
                    {state.failure.kind === 'session'
                      ? t('poo70.c7.dialog.errorSession')
                      : state.failure.kind === 'still-member'
                        ? t('poo70.c7.dialog.errorStillMember')
                        : state.failure.kind === 'suspended'
                          ? t('poo70.c7.dialog.errorSuspended')
                          : t('poo70.c7.dialog.errorRejected')}
                  </p>
                </div>
              )}
              <p className="m-0 text-[13px] leading-[1.6] text-foreground-80">
                {state.lastSourceWorkNames.length > 0
                  ? t('poo70.c7.dialog.bodyLastSource')
                  : t('poo70.c7.dialog.bodyDefault')}
              </p>
              {state.lastSourceWorkNames.length > 0 && (
                <ul
                  className="m-[8px_0_0] list-none p-0 text-[13px] leading-[1.6] text-foreground"
                  data-testid="leave-circle-dialog-last-source"
                >
                  {state.lastSourceWorkNames.map(name => (
                    <li key={name} className="border-border border-b py-[6px] last:border-b-0">
                      {name}
                    </li>
                  ))}
                </ul>
              )}
              <p className="m-[10px_0_0] text-[11px] leading-[1.45] text-foreground-50">
                {t('poo70.c7.dialog.note')}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-[8px] border-border border-t px-[20px] py-[13px]">
          <button
            type="button"
            data-testid="leave-circle-dialog-cancel"
            ref={cancelRef}
            disabled={cancelDisabled}
            className="inline-flex min-h-[28px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={cancel}
          >
            {t('poo70.c7.dialog.cancel')}
          </button>
          <button
            type="button"
            data-testid="leave-circle-dialog-confirm"
            disabled={confirmDisabled}
            className="inline-flex min-h-[32px] items-center justify-center gap-[6px] whitespace-nowrap rounded-[8px] border border-destructive bg-destructive px-[12px] text-[12px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onConfirm}
          >
            {confirming ? t('poo70.c7.dialog.confirming') : t('poo70.c7.dialog.confirm')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
