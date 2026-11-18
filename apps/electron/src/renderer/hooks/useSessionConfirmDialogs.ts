/**
 * Session confirmation dialogs (share-create + delete), built on the app's one
 * design-system ConfirmDialog.
 *
 * - 创建共享链接 publishes the conversation as "anyone with the link can
 *   view", which is a high-cost mis-tap, so the FIRST create asks for
 *   confirmation (naming the session, stating the consequence). Stop-sharing
 *   and update-share stay one reversible tap (see useSessionMenuActions).
 * - 删除会话 previously rode the OS-native dialog; it now uses the same
 *   in-app ConfirmDialog as every other destructive ask. The empty-session
 *   auto-delete path bypasses this entirely (App.tsx keeps that logic).
 *
 * Pure spec builders are exported for focused tests; `useShareSessionConfirm`
 * wires the share ask so every share entry point (session list, chat header,
 * title menus) renders the identical dialog.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfirmDialogSpec } from '@/components/ui/confirm-dialog'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { shareSessionToViewer } from '@/hooks/useSessionMenuActions'

/** Minimal translator shape so the builders stay testable without i18next generics. */
type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Ask before creating a public share link. Not destructive — the link is
 * revocable — so the confirm button takes primary (not red) styling.
 */
export function shareSessionConfirmSpec(name: string, t: Translate): ConfirmDialogSpec {
  return {
    testId: 'share-session-confirm-dialog',
    title: t('dialog.shareSession.title', { name }),
    description: t('dialog.shareSession.description'),
    confirmLabel: t('dialog.shareSession.confirm'),
    destructive: false,
  }
}

/** Ask before deleting a conversation: names the session, states the loss. */
export function deleteSessionConfirmSpec(name: string, t: Translate): ConfirmDialogSpec {
  return {
    testId: 'delete-session-confirm-dialog',
    title: t('dialog.deleteSession.title', { name }),
    description: t('dialog.deleteSession.description'),
    confirmLabel: t('common.delete'),
    destructive: true,
  }
}

export interface ShareSessionTarget {
  id: string
  /** Display title interpolated into the dialog title. */
  name: string
}

/**
 * Confirm-then-publish gate for creating a share link. Returns `requestShare`
 * (opens the dialog; on confirm the link is created and copied exactly like
 * the old direct path) and `confirmElement` (render by the owner — it must
 * outlive the menu/drawer that triggered the ask).
 */
export function useShareSessionConfirm(): {
  requestShare: (target: ShareSessionTarget) => void
  confirmElement: React.ReactNode
} {
  const { t } = useTranslation()
  const { requestConfirm, confirmElement } = useConfirmDialog()

  const requestShare = React.useCallback((target: ShareSessionTarget) => {
    void requestConfirm({
      ...shareSessionConfirmSpec(target.name, t),
      onConfirm: () => shareSessionToViewer(target.id, t),
    })
  }, [requestConfirm, t])

  return { requestShare, confirmElement }
}
