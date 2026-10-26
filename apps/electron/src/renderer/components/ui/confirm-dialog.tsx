/**
 * Journey #7 — the one design-system confirmation dialog for dangerous
 * actions, replacing every renderer `window.confirm` (which could neither be
 * styled, localized, nor made double-click-safe).
 *
 * Contract (mirrors the LeaveCircleDialog dialog conventions):
 * - 原对象与影响明确: the caller puts the object in the title and the impact
 *   in the description — nothing is inferred here.
 * - 取消/ESC/outside dismissal NEVER write: they just resolve/close.
 * - 确认中防重复: while the confirm action runs, BOTH buttons are disabled
 *   and the confirm click path is re-entrancy guarded.
 * - 失败保留对象可重试: a rejected (or thrown) confirm action keeps the
 *   dialog open, shows the error inline, and re-enables the confirm button —
 *   the object is never consumed by a failed attempt.
 * - 关闭后焦点返回触发器: Radix restores focus to the trigger by default;
 *   we keep that (no onOpenAutoFocus override on close) and focus the cancel
 *   button on open (destructive actions must not be one accidental Enter
 *   away).
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRegisterModal } from '@/context/ModalContext'

export interface ConfirmDialogSpec {
  /** Stable hook for tests/e2e. */
  testId?: string
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive styling on the confirm button (default TRUE — these are dangerous operations). */
  destructive?: boolean
  /**
   * The write. Runs exactly once per confirmed attempt; while it runs the
   * dialog is busy (no double fire); on failure the dialog stays open with
   * the error for a deliberate retry; on success the dialog closes and
   * `onSettled(true)` fires.
   */
  onConfirm?: () => Promise<void> | void
}

export function ConfirmDialog({
  spec,
  onSettled,
}: {
  spec: ConfirmDialogSpec | null
  /** `true` = confirmed (and any onConfirm write SUCCEEDED); `false` = cancelled. */
  onSettled: (confirmed: boolean) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)
  const [errorText, setErrorText] = React.useState<string | null>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)

  // Reset per open: a failed attempt's error must not leak into the next ask.
  React.useEffect(() => {
    if (spec) {
      setBusy(false)
      setErrorText(null)
    }
  }, [spec])

  const close = React.useCallback((confirmed: boolean) => {
    if (busy) return
    onSettled(confirmed)
  }, [busy, onSettled])

  useRegisterModal(!!spec, () => close(false))

  const confirm = React.useCallback(() => {
    if (busy) return
    const action = spec?.onConfirm
    if (!action) {
      onSettled(true)
      return
    }
    setBusy(true)
    setErrorText(null)
    void (async () => {
      try {
        await action()
        onSettled(true)
      } catch (caught) {
        // The object survives the failed attempt: keep the dialog open for a
        // deliberate retry, with the failure stated plainly.
        setBusy(false)
        setErrorText(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }, [spec, busy, onSettled])

  if (!spec) return null

  const destructive = spec.destructive ?? true

  return (
    <Dialog open onOpenChange={open => { if (!open) close(false) }}>
      <DialogContent
        data-testid={spec.testId ?? 'confirm-dialog'}
        className="max-w-[380px] gap-0 p-5"
        showCloseButton={false}
        onOpenAutoFocus={event => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
        onInteractOutside={event => event.preventDefault()}
      >
        <DialogTitle className="text-[15px] font-semibold text-foreground">
          {spec.title}
        </DialogTitle>
        {spec.description && (
          <DialogDescription className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
            {spec.description}
          </DialogDescription>
        )}
        {errorText && (
          <div
            data-testid="confirm-dialog-error"
            className="mt-2 flex items-start gap-1.5 rounded-[6px] bg-destructive/10 px-2 py-1.5 text-[12px] leading-4 text-destructive"
          >
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{errorText}</span>
          </div>
        )}
        <DialogFooter className="mt-4 flex-row gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            data-testid="confirm-dialog-cancel"
            disabled={busy}
            onClick={() => close(false)}
          >
            {spec.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            data-testid="confirm-dialog-action"
            disabled={busy}
            onClick={confirm}
          >
            {spec.confirmLabel ?? t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface PendingConfirm {
  resolve: (confirmed: boolean) => void
}

/**
 * Promise-style adapter for call sites shaped like `window.confirm`:
 * `if (await requestConfirm({ title, description })) { ... }`. Renders the
 * dialog element itself — mount `confirmElement` next to the host component.
 * A pending ask is auto-cancelled (resolved false) when replaced or when the
 * owner unmounts, so a stale resolver can never fire a late write.
 */
export function useConfirmDialog(): {
  requestConfirm: (spec: ConfirmDialogSpec) => Promise<boolean>
  confirmElement: React.ReactNode
} {
  const [spec, setSpec] = React.useState<ConfirmDialogSpec | null>(null)
  const pendingRef = React.useRef<PendingConfirm | null>(null)

  const settle = React.useCallback((confirmed: boolean) => {
    setSpec(null)
    const pending = pendingRef.current
    pendingRef.current = null
    pending?.resolve(confirmed)
  }, [])

  const requestConfirm = React.useCallback((next: ConfirmDialogSpec) => {
    // One ask at a time: a superseded ask is cancelled, never left dangling.
    pendingRef.current?.resolve(false)
    return new Promise<boolean>(resolve => {
      pendingRef.current = { resolve }
      setSpec(next)
    })
  }, [])

  React.useEffect(() => () => {
    // Unmount mid-ask resolves as a cancel — the caller never writes.
    pendingRef.current?.resolve(false)
    pendingRef.current = null
  }, [])

  const confirmElement = <ConfirmDialog spec={spec} onSettled={settle} />
  return { requestConfirm, confirmElement }
}
