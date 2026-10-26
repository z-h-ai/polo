/**
 * useSessionMenuActions
 *
 * Single source of truth for session-menu side effects (share / refresh title /
 * copy path / show in finder / export to file / open in new panel /
 * share-submenu actions / label toggle). Consumed by both `SessionMenu`
 * (desktop dropdown / context menu) and `CompactSessionMenu` (compact-mode
 * drawer) so a new session action only has to be wired through one place.
 *
 * Also owns **optimistic label state**: the parent's labels-changed pipeline
 * (`onLabelsChange` → IPC → server → `labels_changed` event → atom → re-render)
 * is asynchronous, so a fast second tap that derived from the prop's stale
 * `item.labels` would compute against an out-of-date snapshot and could
 * overwrite the first tap's update. The hook keeps a local optimistic copy
 * mirrored in a `useRef` so toggles read the latest value synchronously
 * (without going through React's update queue, which would be impure under
 * Strict Mode and could double-fire `onLabelsChange`). Prop sync only runs
 * when the server has acknowledged our latest local change (tracked via
 * `lastSentKeyRef`) — avoids a brief checkmark-flash without needing a full
 * request-tracking layer. State is hard-reset when `item.id` changes so
 * pending optimistic state from a previous session can't leak into a new one.
 *
 * Pure label-mutation logic lives in `@polo-ai/shared/labels`
 * (`toggleLabelInList`) and is unit-tested there.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { navigate, routes } from '@/lib/navigate'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { extractLabelId, toggleLabelInList } from '@polo-ai/shared/labels'
import type { SessionMeta } from '@/atoms/sessions'

export interface UseSessionMenuActionsOptions {
  item: SessionMeta
  onLabelsChange?: (labels: string[]) => void
}

export interface SessionMenuActions {
  /** Set of base label IDs currently applied (optimistic). */
  appliedLabelIds: Set<string>
  /** Toggle a label (add if absent, remove all entries with this base ID if present). */
  toggleLabel: (labelId: string) => void
  share: () => Promise<void>
  /** Journey #7: mount next to the host menu — renders the share confirm dialog. */
  confirmElement: React.ReactNode
  showInFinder: () => void
  copySessionId: () => Promise<void>
  copyPath: () => Promise<void>
  /** Export the session bundle to a JSON file via the OS save dialog (no-op when cancelled). */
  exportSession: () => Promise<void>
  refreshTitle: () => Promise<void>
  openInNewPanel: () => void
  /** Open the session's published share URL in the system browser (no-op if not shared). */
  openSharedInBrowser: () => void
  /** Copy the session's published share URL to the clipboard (no-op if not shared). */
  copySharedLink: () => Promise<void>
  /** Re-publish the share to bump the snapshot. */
  updateShare: () => Promise<void>
  /** Revoke the share. */
  revokeShare: () => Promise<void>
}

// SOH (U+0001) — non-printable so it can't collide with label IDs (which
// validate to [a-z0-9-]) or values (which may themselves contain '::').
const LABEL_KEY_SEPARATOR = String.fromCharCode(1)

function joinLabelKey(labels: readonly string[] | undefined): string {
  return (labels ?? []).join(LABEL_KEY_SEPARATOR)
}

export function useSessionMenuActions({
  item,
  onLabelsChange,
}: UseSessionMenuActionsOptions): SessionMenuActions {
  const { t } = useTranslation()
  const sessionId = item.id
  const sharedUrl = item.sharedUrl
  const propLabels = item.labels

  const [optimisticLabels, setOptimisticLabels] = React.useState<string[]>(() => propLabels ?? [])
  // Mirror of `optimisticLabels` so toggles can read the latest value
  // synchronously without going through React's update queue. Reading from
  // a state-updater callback would be impure (Strict Mode can invoke updaters
  // twice in dev), which would double-fire onLabelsChange.
  const optimisticLabelsRef = React.useRef<string[]>(propLabels ?? [])
  const propKey = React.useMemo(() => joinLabelKey(propLabels), [propLabels])
  const lastSentKeyRef = React.useRef<string | null>(null)

  // Hard-reset on session change so optimistic state from a previous session
  // cannot leak into a new one (e.g. user toggles `bug` on session A, navigates
  // to B before the IPC ACK — without this reset, lastSentKeyRef would block
  // the prop sync and B would briefly render A's labels).
  React.useEffect(() => {
    const next = propLabels ?? []
    optimisticLabelsRef.current = next
    lastSentKeyRef.current = null
    setOptimisticLabels(next)
    // Intentionally only depending on sessionId — propLabels changes within
    // the same session are handled by the prop-sync effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  React.useEffect(() => {
    // Sync from prop only when the server has caught up to (or surpassed)
    // our last sent value — otherwise an in-flight prop update would briefly
    // erase a queued local toggle. lastSentKeyRef === null means we have
    // no pending local changes, so the prop is authoritative.
    if (lastSentKeyRef.current === null || lastSentKeyRef.current === propKey) {
      const next = propLabels ?? []
      optimisticLabelsRef.current = next
      setOptimisticLabels(next)
      lastSentKeyRef.current = null
    }
  }, [propKey, propLabels])

  const appliedLabelIds = React.useMemo(
    () => new Set(optimisticLabels.map(extractLabelId)),
    [optimisticLabels],
  )

  const toggleLabel = React.useCallback((labelId: string) => {
    if (!onLabelsChange) return
    // Read the canonical latest value from the ref, mutate refs, fire the
    // callback, and only THEN call setState. All side effects happen outside
    // any state-updater callback so they fire exactly once per user tap
    // even under Strict Mode's double-render checks.
    const next = toggleLabelInList(optimisticLabelsRef.current, labelId)
    optimisticLabelsRef.current = next
    lastSentKeyRef.current = joinLabelKey(next)
    setOptimisticLabels(next)
    onLabelsChange(next)
  }, [onLabelsChange])

  // Journey #7: sharing publishes the session — the warning (what becomes
  // public) lives in locales, the ask uses the shared confirm dialog.
  const { requestConfirm, confirmElement } = useConfirmDialog()

  const share = React.useCallback(async () => {
    const confirmed = await requestConfirm({
      testId: 'share-confirm',
      title: t('chat.shareConfirm.title'),
      description: t('chat.shareConfirm.description'),
      confirmLabel: t('chat.shareConfirm.confirm'),
    })
    if (!confirmed) {
      return
    }
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: {
          label: t('common.open'),
          onClick: () => window.electronAPI.openUrl(result.url!),
        },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t, requestConfirm])

  const showInFinder = React.useCallback(() => {
    window.electronAPI.sessionCommand(sessionId, { type: 'showInFinder' })
  }, [sessionId])

  const copySessionId = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sessionId)
      toast.success(t('toast.sessionIdCopied'))
    } catch {
      toast.error(t('toast.failedToCopySessionId'))
    }
  }, [sessionId, t])

  const copyPath = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'copyPath' }) as { success: boolean; path?: string } | undefined
    if (result?.success && result.path) {
      await navigator.clipboard.writeText(result.path)
      toast.success(t('toast.pathCopied'))
    }
  }, [sessionId, t])

  // Export-to-file runs a main-process save dialog (which can stay open
  // arbitrarily long); the busy flag just guards against a double-fire from
  // re-opening the menu and tapping Export again while a dialog is pending.
  const [isExporting, setIsExporting] = React.useState(false)

  const exportSession = React.useCallback(async () => {
    if (isExporting) return
    setIsExporting(true)
    try {
      const filePath = await window.electronAPI.exportSessionToFile(sessionId)
      if (filePath) {
        toast.success(t('sessionMenu.exportSuccess'))
        // Reveal the file — failure to reveal is non-fatal (export succeeded).
        window.electronAPI.showInFolder(filePath).catch(() => {})
      }
      // filePath === null → user cancelled the save dialog: no toast.
    } catch {
      toast.error(t('sessionMenu.exportFailed'))
    } finally {
      setIsExporting(false)
    }
  }, [sessionId, t, isExporting])

  const refreshTitle = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'refreshTitle' }) as { success: boolean; title?: string; error?: string } | undefined
    if (result?.success) {
      toast.success(t('toast.titleRefreshed'), { description: result.title })
    } else {
      toast.error(t('toast.failedToRefreshTitle'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const openInNewPanel = React.useCallback(() => {
    navigate(routes.view.allSessions(sessionId), { newPanel: true })
  }, [sessionId])

  const openSharedInBrowser = React.useCallback(() => {
    if (!sharedUrl) return
    window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const copySharedLink = React.useCallback(async () => {
    if (!sharedUrl) return
    await navigator.clipboard.writeText(sharedUrl)
    toast.success(t('toast.linkCopied'))
  }, [sharedUrl, t])

  const updateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t('chat.failedToUpdateShare'), { description: errorMsg })
    }
  }, [sessionId, t])

  const revokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t('chat.failedToStopSharing'), { description: errorMsg })
    }
  }, [sessionId, t])

  return {
    appliedLabelIds,
    toggleLabel,
    share,
    /** Journey #7: mount next to the host menu — renders the share confirm dialog. */
    confirmElement,
    showInFinder,
    copySessionId,
    copyPath,
    exportSession,
    refreshTitle,
    openInNewPanel,
    openSharedInBrowser,
    copySharedLink,
    updateShare,
    revokeShare,
  }
}
