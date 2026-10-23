import { useEffect, useInsertionEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getAppCatalogApps } from '@polo-ai/shared/admin/catalog-view'
import { unwrapLocalAppAdmission, type ProductSpaceAppRuntimeStartResult } from '@polo-ai/shared/protocol'
import { useOptionalMemberCatalog } from '@/context/MemberCatalogContext'
import { useOptionalProductSpaceContext, useProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
import { useTabShell } from '@/context/TabShellContext'
import { identityForProductSpaceApp } from '@/hooks/useAppCatalog'
import { openTabsAtom, activeTabIdAtom, closeTabAtom, updateTabInfoAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, createTabId, type TabInstance } from '../../../shared/tab-browser-types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type OwnedApp = {
  tab: TabInstance
  handle?: ProductSpaceAppRuntimeStartResult
  starting: boolean
  /** Catalog name at launch; unlike tab.title it never becomes the guest page title. */
  appName: string
}
const stopExact = (handle: ProductSpaceAppRuntimeStartResult) => window.electronAPI.localApps.stop({
  kind: 'product_space_runtime_handle', executionId: handle.executionId,
  expectedRuntimeGeneration: handle.runtimeGeneration,
})

/**
 * POO107-02/03 close decision for a runtime-backed App tab (Q1: the managed
 * process is the truth — no in-app busy detection). LIST returns only ACTIVE
 * scope executions, so "executionId absent from a successful response" is the
 * reliable ended signal; a failed/throwing query is UNKNOWN and must never
 * close the tab (POO107-06).
 */
async function fetchRuntimeActive(handle: ProductSpaceAppRuntimeStartResult, tab: TabInstance): Promise<boolean | null> {
  const scope = tab.productSpaceApp
  if (!scope) return false
  try {
    const result = await window.electronAPI.productSpaceListActiveExecutions(scope.accountId, scope.productSpaceId)
    if (!result.success) return null
    return result.executions.some(execution => execution.executionId === handle.executionId)
  } catch {
    return null
  }
}

/** Persistent shell consumer: catalog/launch credentials never enter persisted tabs. */
export function ProductSpaceAppLaunchBridge() {
  const catalog = useOptionalMemberCatalog()
  const space = useOptionalProductSpaceContext()
  const handoff = useProductSpaceAppLaunchHandoff()
  const { isReady, registerProductSpaceTabClose } = useTabShell()
  const store = useStore()
  const { t } = useTranslation()
  const records = useRef(new Map<string, OwnedApp>())
  const epoch = useRef<object | null>(null)
  const checkingTabs = useRef(new Set<string>())
  // Mirrors `closing` for async comparisons: the tab-close registration
  // effect closes over the first render's state, so awaited completions must
  // check the ref, never the captured state.
  const closingRef = useRef<OwnedApp | null>(null)
  const openCloseDialog = (record: OwnedApp | null) => { closingRef.current = record; setClosing(record) }
  const [closing, setClosing] = useState<OwnedApp | null>(null)
  const [closingEpoch, setClosingEpoch] = useState<object | null>(null)
  const [stopping, setStopping] = useState(false)
  // POO107-05: while a STOP is in flight, a second close (× button or
  // Cmd/Ctrl+W) must be swallowed, not reopen or reset the confirmation.
  // The handler closes over first-render state, so it reads the ref.
  const stoppingRef = useRef(false)
  const applyStopping = (value: boolean) => { stoppingRef.current = value; setStopping(value) }
  const [closeError, setCloseError] = useState<string | null>(null)
  // POO107-06: the activity query failed — the dialog offers retry instead of
  // pretending the tab has no tasks. `checking` covers the initial query and
  // every retry so neither branch can act on a stale answer.
  const [statusUnknown, setStatusUnknown] = useState(false)
  const [checking, setChecking] = useState(false)
  // Insertion cleanup fences old completions before the next scope's layout effects.
  useInsertionEffect(() => {
    const token = {}; epoch.current = token
    return () => {
      if (epoch.current === token) epoch.current = null
      checkingTabs.current.clear()
      for (const record of records.current.values()) {
        if (record.handle) void stopExact(record.handle).catch(() => {})
      }
      records.current.clear()
    }
  }, [space?.accountId, space?.activeProductSpaceId, space?.contextVersion])

  useEffect(() => {
    checkingTabs.current.clear()
    closingRef.current = null; setClosing(null)
    setClosingEpoch(null); applyStopping(false); setCloseError(null)
    setStatusUnknown(false); setChecking(false)
  }, [space?.accountId, space?.activeProductSpaceId, space?.contextVersion])

  useLayoutEffect(() => {
    if (!isReady || !space || !catalog) return
    const token = epoch.current
    const current = () => token !== null && epoch.current === token
    const reveal = (record: OwnedApp) => {
      if (!current()) return
      record.tab.background = false
      if (!store.get(openTabsAtom).some(tab => tab.id === record.tab.id)) {
        store.set(openTabsAtom, [...store.get(openTabsAtom), record.tab])
      } else {
        store.set(updateTabInfoAtom, record.tab)
      }
      store.set(activeTabIdAtom, record.tab.id)
    }
    return handoff.onLaunch(request => {
      const pending = handoff.take(request.handoffId, request.context)
      if (!pending || !current()) return
      const { context } = request
      const key = JSON.stringify([context.accountId, context.productSpaceId, context.artifactInstanceId, context.versionId, context.version])
      void (async () => {
        const snapshot = catalog.state.catalog
        const app = snapshot && getAppCatalogApps(snapshot).find(entry => entry.catalogEntryId === context.catalogEntryId
          && entry.artifactInstanceId === context.artifactInstanceId && entry.catalogVersion?.versionId === context.versionId
          && entry.catalogVersion.version === context.version)
        if (!snapshot || !app || app.availability !== 'available' || catalog.state.accessMode !== 'online'
          || snapshot.accountId !== context.accountId || snapshot.organizationId !== context.productSpaceId) {
          throw new Error(t('homeApps.errors.staleContext'))
        }
        const previous = records.current.get(key)
        if (previous?.starting) { reveal(previous); return }
        if (previous && !previous.tab.runtimeError) {
          if (previous.handle) {
            const result = await window.electronAPI.productSpaceListActiveExecutions(context.accountId, context.productSpaceId)
            if (!current()) return
            const latest = records.current.get(key)
            if (latest !== previous && latest) { reveal(latest); return }
            if (!result.success) throw new Error(t('homeApps.errors.staleContext'))
            if (result.executions.some(item => item.executionId === previous.handle!.executionId)) { reveal(previous); return }
          } else { reveal(previous); return }
        }
        if (!current()) return
        if (previous) store.set(closeTabAtom, previous.tab.id)
        const record: OwnedApp = { starting: true, appName: app.name, tab: {
          id: createTabId('product-space-app'), appId: context.artifactInstanceId,
          type: 'webapp', title: app.name, isLoading: true, productSpaceApp: { accountId: space.accountId, productSpaceId: space.activeProductSpaceId, contextVersion: space.contextVersion },
        } }
        records.current.set(key, record)
        reveal(record)
        try {
          if (pending.launch.delivery.kind === 'web_url') {
            record.tab.url = pending.launch.delivery.url
          } else {
            const handle = unwrapLocalAppAdmission(await window.electronAPI.localApps.start({
              kind: 'product_space_runtime_start', app: identityForProductSpaceApp(snapshot, app),
            })) as ProductSpaceAppRuntimeStartResult
            record.handle = handle
            if (!current()) { await stopExact(handle); return }
            const url = handle.uiUrl ? new URL(handle.uiUrl) : null
            if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
              await stopExact(handle)
              record.handle = undefined
              throw new Error(t('homeApps.runtimeTab.noUrl'))
            }
            record.tab.url = handle.uiUrl
          }
          record.starting = false
          record.tab.isLoading = false
          if (current()) store.set(updateTabInfoAtom, record.tab)
        } catch (error) {
          record.starting = false
          record.tab.isLoading = false
          record.tab.runtimeError = error instanceof Error ? error.message : t('homeApps.runtimeTab.failed')
          if (current()) store.set(updateTabInfoAtom, record.tab)
          throw error
        }
      })().catch(error => {
        if (current()) toast.error(t('homeApps.errors.openTitle', { name: 'App' }), { description: error instanceof Error ? error.message : undefined })
      })
    })
  }, [catalog, handoff, isReady, space, store, t])

  useEffect(() => {
    registerProductSpaceTabClose?.(tabId => {
      const record = [...records.current.values()].find(value => value.tab.id === tabId)
      if (!record) return false
      if (record.starting) { toast.info(t('common.loading')); return true }
      // POO107-05: a STOP already in flight keeps the dialog as-is — a second
      // × or Cmd/Ctrl+W must neither stack a new ask nor re-enable Cancel.
      if (stoppingRef.current) return true
      // No managed runtime handle (plain web pages, failed starts): POO107-02
      // closes directly — there is nothing Polo-managed to confirm.
      if (!record.handle) { store.set(closeTabAtom, tabId); return true }
      // POO107-08: a second click while the activity query is in flight must
      // not stack a second dialog or query for the same tab.
      if (checkingTabs.current.has(tabId)) return true
      checkingTabs.current.add(tabId)
      setCloseError(null); applyStopping(false); setStatusUnknown(false); setChecking(true)
      setClosingEpoch(epoch.current); openCloseDialog(record)
      const token = epoch.current
      void (async () => {
        const active = await fetchRuntimeActive(record.handle!, record.tab)
        if (token === null || token !== epoch.current || closingRef.current !== record) {
          checkingTabs.current.delete(tabId)
          return
        }
        setChecking(false)
        checkingTabs.current.delete(tabId)
        if (active === null) { setStatusUnknown(true); return }
        if (!active) {
          // Reliably confirmed ended: close without the terminate dialog —
          // a stale handle must never resurrect the POO-55 three-option ask.
          openCloseDialog(null)
          store.set(closeTabAtom, tabId)
        }
      })()
      return true
    })
    return () => registerProductSpaceTabClose?.(null)
  }, [registerProductSpaceTabClose, store, t])

  const settleClosed = (target: OwnedApp) => {
    target.handle = undefined
    target.tab.url = undefined
    target.tab.runtimeError = t('homeApps.runtimeTab.stopped')
    store.set(closeTabAtom, target.tab.id)
    openCloseDialog(null)
    setStatusUnknown(false)
  }
  const stopAndClose = async () => {
    const target = closing; const token = closingEpoch
    if (!target?.handle || stoppingRef.current || !token || token !== epoch.current) return
    applyStopping(true); setCloseError(null)
    try {
      await stopExact(target.handle)
      if (token !== epoch.current) return
      settleClosed(target)
    } catch {
      if (token !== epoch.current) return
      // POO107-08: the execution may have ended naturally between the
      // activity check and the confirmed stop — verify before showing an
      // error, and never let a failed exact stop close the tab.
      const active = await fetchRuntimeActive(target.handle!, target.tab)
      if (token !== epoch.current || closingRef.current !== target) return
      if (active === false) { settleClosed(target); return }
      // POO107-06: an unverifiable state never pretends to be a stop failure —
      // switch to the unknown-state ask; a confirmed still-running execution
      // reports the stop failure verbatim.
      setCloseError(active === null ? null : t('homeApps.runtimeTab.stopFailed'))
      setStatusUnknown(active === null)
    } finally { if (token === epoch.current) applyStopping(false) }
  }
  const retryCloseCheck = () => {
    const target = closing; const token = closingEpoch
    if (!target?.handle || checking || !token || token !== epoch.current) return
    setChecking(true); setStatusUnknown(false); setCloseError(null)
    void (async () => {
      const active = await fetchRuntimeActive(target.handle!, target.tab)
      if (token !== epoch.current || closingRef.current !== target) return
      setChecking(false)
      if (active === null) { setStatusUnknown(true); return }
      if (!active) {
        openCloseDialog(null)
        store.set(closeTabAtom, target.tab.id)
      }
    })()
  }
  const dismissCloseDialog = () => { openCloseDialog(null); setStatusUnknown(false) }
  const closingScope = closing?.tab.productSpaceApp
  const closingIsCurrent = closingScope?.accountId === space?.accountId
    && closingScope?.productSpaceId === space?.activeProductSpaceId
    && closingScope?.contextVersion === space?.contextVersion
  // POO107-03: the ask offers exactly Cancel + Stop-and-close (or Retry) — no
  // extra corner X; Esc still dismisses via onOpenChange as a Cancel, but is
  // held while a check is in flight — same contract as the disabled Cancel.
  return <Dialog open={Boolean(closing && closingIsCurrent)} onOpenChange={open => { if (!open && !stopping && !checking) dismissCloseDialog() }}>
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{t('homeApps.runtimeTab.closeTitle', { name: closing?.appName ?? '' })}</DialogTitle>
        <DialogDescription>
          {statusUnknown ? t('homeApps.runtimeTab.statusUnknown') : t('homeApps.runtimeTab.closeDescription')}
        </DialogDescription>
      </DialogHeader>
      {closeError && <p role="alert">{closeError}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={stopping || checking} onClick={dismissCloseDialog}>{t('common.cancel')}</Button>
        {statusUnknown
          ? <Button disabled={checking} onClick={() => void retryCloseCheck()}>{checking ? t('common.loading') : t('homeApps.runtimeTab.retry')}</Button>
          : <Button disabled={stopping || checking} onClick={() => void stopAndClose()}>{stopping ? t('common.loading') : t('homeApps.runtimeTab.stopAndClose')}</Button>}
      </div>
    </DialogContent>
  </Dialog>
}
