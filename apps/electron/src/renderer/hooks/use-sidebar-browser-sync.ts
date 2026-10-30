/**
 * POO-135: renderer-side wiring between Main's BrowserPaneManager and the
 * sidebar browser atoms. The production app previously had no subscriber for
 * `browser-pane:*` events (only the playground tab strip did); this hook is
 * the sidebar's single sync + reaction point:
 *
 * - mirrors list / state-changed / removed into atoms/browser-pane.ts
 * - system-close of a detached popup window → returns the browser to the
 *   sidebar (embed back), keeping URL/content/draft references
 * - element-picker outcomes: picked → append to the target session's draft
 *   (switching to that session first, per the prototype), cancelled → clear
 *   the armed state (+ toast on navigation or chat switch), unavailable →
 *   explicit refusal toast
 * - terminate with「浏览器已结束」toast +「重新打开」(same address, same
 *   ownership, NEW stable instance — never a resurrected window)
 */

import { useCallback, useEffect, useRef } from 'react'
import { useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { BrowserInstanceInfo, BrowserElementPickerEvent } from '../../shared/types'
import {
  browserInstancesMapAtom,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import {
  activeElementPickingAtom,
  elementDraftRefsAtomFamily,
  filterSidebarBrowserInstances,
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} from '@/atoms/sidebar-browser'
import { queuePendingFocusForSession } from '@/components/app-shell/input/focus-input-events'

interface UseSidebarBrowserSyncOptions {
  onBrowserPresented?: () => void
  currentSessionId: string | null
  activeWorkspaceId: string | null
  remoteWorkspaceId: string | null
  /** Switch the app's selected chat session (used when a pick lands elsewhere). */
  onSelectSession: (sessionId: string) => void
}

export interface SidebarBrowserSyncControls {
  /** Terminate a browser; ending the LAST visible one toasts + offers reopen. */
  terminateBrowser: (instance: BrowserInstanceInfo) => Promise<void>
}

export function useSidebarBrowserSync({
  onBrowserPresented,
  currentSessionId,
  activeWorkspaceId,
  remoteWorkspaceId,
  onSelectSession,
}: UseSidebarBrowserSyncOptions): SidebarBrowserSyncControls {
  const { t } = useTranslation()
  const onPresentedRef = useRef(onBrowserPresented)
  onPresentedRef.current = onBrowserPresented
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  // The ambient jotai store (the <JotaiProvider> context store) — NOT
  // getDefaultStore(): the production provider creates its own store, so
  // writes to the default store are invisible to useAtomValue readers
  // (POO-135 r3). Callbacks reach it through a ref so they never act on a
  // stale closure, same discipline as onSelectSessionRef below.
  const store = useStore()
  const storeRef = useRef(store)
  storeRef.current = store
  const onSelectSessionRef = useRef(onSelectSession)
  onSelectSessionRef.current = onSelectSession
  const pendingReturnsRef = useRef(new Map<string, BrowserInstanceInfo>())
  const currentSessionIdRef = useRef(currentSessionId)
  currentSessionIdRef.current = currentSessionId

  const visibleCountExcluding = useCallback((excludedId: string): number => {
    const store = storeRef.current
    const rest = Array.from(store.get(browserInstancesMapAtom).values()).filter((i) => i.id !== excludedId)
    return filterSidebarBrowserInstances(rest, currentSessionIdRef.current, activeWorkspaceId, remoteWorkspaceId).length
  }, [activeWorkspaceId, remoteWorkspaceId])

  // Initial mirror + event subscriptions. Handlers read fresh state through
  // the context store (via storeRef) so callbacks never act on stale closures.
  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api?.list || !window.electronAPI.isChannelAvailable?.('browser-pane:list')) return

    let disposed = false
    void api.list().then((instances) => {
      if (!disposed) setInstances(instances)
    }).catch(() => {})

    const offState = api.onStateChanged((info) => {
      updateInstance(info)
      if (info.hostMode === 'popup' && info.sidebarHostWindowId && storeRef.current.get(sidebarBrowserInstanceIdAtom) === info.id) storeRef.current.set(sidebarBrowserOpenAtom, false)
    })

    const offOpen = api.onOpenRequested?.((info, reason) => {
      updateInstance(info)
      // Closing A's window must not replace B's content. An explicit open
      // may select the owning chat, while a return never changes chats.
      const current = currentSessionIdRef.current
      if (reason === 'automatic' && (!current || info.ownerSessionId !== current || !info.workspaceId ||
          (info.workspaceId !== activeWorkspaceId && info.workspaceId !== remoteWorkspaceId))) return
      if (activeWorkspaceId || remoteWorkspaceId) {
        if (info.workspaceId && info.workspaceId !== activeWorkspaceId && info.workspaceId !== remoteWorkspaceId) return
      }
      if (info.ownerSessionId && info.ownerSessionId !== current) {
        if (reason === 'return') {
          pendingReturnsRef.current.set(info.id, info)
          return
        }
        onSelectSessionRef.current(info.ownerSessionId)
      }
      onPresentedRef.current?.()
      const store = storeRef.current
      store.set(sidebarBrowserInstanceIdAtom, info.id)
      store.set(sidebarBrowserOpenAtom, true)
      store.set(rightPaneTabAtom, 'browser')
      void api.embed(info.id).catch(() => toast.error(t('toast.failedToEmbedBrowser')))
    }) ?? (() => {})

    const offRemoved = api.onRemoved((id) => {
      pendingReturnsRef.current.delete(id)
      removeInstance(id)
      const store = storeRef.current
      if (store.get(sidebarBrowserInstanceIdAtom) === id) {
        store.set(sidebarBrowserInstanceIdAtom, null)
      }
      if (visibleCountExcluding(id) === 0) store.set(sidebarBrowserOpenAtom, false)
      const picking = store.get(activeElementPickingAtom)
      if (picking?.instanceId === id) store.set(activeElementPickingAtom, null)
    })

    const offPicker = api.onElementPickerEvent?.((event) => {
      handlePickerEvent(event)
    }) ?? (() => {})

    return () => {
      disposed = true
      offState()
      offOpen()
      offRemoved()
      offPicker()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, remoteWorkspaceId, removeInstance, setInstances, t, updateInstance, visibleCountExcluding])

  // A popup closed while B was active returns when its owner A is selected;
  // it neither switches chats nor steals B's right pane during close.
  useEffect(() => {
    for (const [id, info] of pendingReturnsRef.current) {
      if (info.ownerSessionId !== currentSessionId) continue
      if ((activeWorkspaceId || remoteWorkspaceId) && info.workspaceId &&
          info.workspaceId !== activeWorkspaceId && info.workspaceId !== remoteWorkspaceId) continue
      pendingReturnsRef.current.delete(id)
      const store = storeRef.current
      store.set(sidebarBrowserInstanceIdAtom, id)
      store.set(sidebarBrowserOpenAtom, true)
      store.set(rightPaneTabAtom, 'browser')
      void window.electronAPI?.browserPane?.embed(id).catch(() => toast.error(t('toast.failedToEmbedBrowser')))
    }
  }, [currentSessionId, activeWorkspaceId, remoteWorkspaceId, t])

  const appendDraftReference = useCallback((sessionId: string, event: Extract<BrowserElementPickerEvent, { kind: 'picked' }>) => {
    const store = storeRef.current
    const family = elementDraftRefsAtomFamily(sessionId)
    store.set(family, [...store.get(family), event.reference])
  }, [])

  const handlePickerEvent = useCallback((event: BrowserElementPickerEvent) => {
    const store = storeRef.current
    if (event.kind === 'picked') {
      const target = event.reference.sessionId
      if (target) {
        appendDraftReference(target, event)
      }
      store.set(activeElementPickingAtom, null)
      if (target && target !== currentSessionIdRef.current) {
        queuePendingFocusForSession(target)
        onSelectSessionRef.current(target)
      }
      return
    }

    if (event.kind === 'unavailable') {
      toast.warning(
        event.reason === 'iframe'
          ? t('browserPane.elementPicker.unavailableFrame')
          : t('browserPane.elementPicker.unavailableGeneric'),
      )
      return
    }

    // cancelled: user Esc is silent; host transitions (embed/detach/hide) are
    // visible on their own; navigation gets an explicit toast because the
    // page the user was picking on is gone. Only a cancellation from the
    // ARMED instance clears the UI — a stale event from a previous instance
    // must not clear a newer picker (POO-135 r1).
    if (event.reason === 'navigation') {
      const picking = store.get(activeElementPickingAtom)
      if (picking?.instanceId === event.instanceId) store.set(activeElementPickingAtom, null)
      toast.info(t('browserPane.elementPicker.cancelledNavigation'))
      return
    }
    const picking = store.get(activeElementPickingAtom)
    if (picking?.instanceId === event.instanceId) store.set(activeElementPickingAtom, null)
  }, [appendDraftReference, t])

  // Switching chats while a picker is armed cancels it — the target never
  // silently re-points at another chat.
  useEffect(() => {
    if (!currentSessionId) return
    const store = storeRef.current
    const picking = store.get(activeElementPickingAtom)
    if (!picking || picking.originSessionId === currentSessionId) return
    store.set(activeElementPickingAtom, null)
    void window.electronAPI?.browserPane?.setElementPicking?.(picking.instanceId, false).catch(() => {})
    toast.info(t('browserPane.elementPicker.cancelledSwitchChat'))
  }, [currentSessionId, t])

  /** Reopen a terminated browser: same URL, same ownership, new instance. */
  const reopenBrowser = useCallback(async (saved: BrowserInstanceInfo): Promise<void> => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    try {
      if (saved.ownerSessionId && saved.ownerSessionId !== currentSessionIdRef.current) {
        onSelectSessionRef.current(saved.ownerSessionId)
      }
      const store = storeRef.current
      const id = await api.create({ show: false, bindToSessionId: saved.ownerSessionId ?? undefined })
      store.set(sidebarBrowserOpenAtom, true)
      store.set(sidebarBrowserInstanceIdAtom, id)
      store.set(rightPaneTabAtom, 'browser')
      const url = saved.url && saved.url !== 'about:blank' ? saved.url : null
      if (url) {
        await api.navigate(id, url)
      }
      await api.embed(id)
    } catch {
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [t])

  /** Terminate a browser; ending the LAST visible one shows the reopen toast. */
  const terminateBrowser = useCallback(async (instance: BrowserInstanceInfo): Promise<void> => {
    const store = storeRef.current
    const api = window.electronAPI?.browserPane
    if (!api) return
    try {
      const destroyed = await api.destroy(instance.id)
      if (destroyed === false) return
    } catch {
      toast.error(t('toast.failedToTerminateBrowser'))
      return
    }

    // The picker can only be armed on one instance at a time; clear it if it
    // was this one (Main emits its own cancelled event, this is just the UI).
    const picking = store.get(activeElementPickingAtom)
    if (picking?.instanceId === instance.id) store.set(activeElementPickingAtom, null)

    if (visibleCountExcluding(instance.id) > 0) return

    // Ending the only browser: close the sidebar browser slot (back to canvas
    // when a canvas is open) and offer a same-address, same-ownership reopen
    // on a NEW stable instance.
    if (store.get(sidebarBrowserOpenAtom)) {
      store.set(sidebarBrowserOpenAtom, false)
      store.set(rightPaneTabAtom, 'canvas')
    }
    toast.success(t('browserPane.ended'), {
      duration: 5000,
      action: {
        label: t('browserPane.reopen'),
        onClick: () => {
          void reopenBrowser(instance)
        },
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, visibleCountExcluding])

  return { terminateBrowser }
}
