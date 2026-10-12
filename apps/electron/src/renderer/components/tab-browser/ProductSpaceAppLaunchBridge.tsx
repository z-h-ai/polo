import { useEffect, useInsertionEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getAppCatalogApps } from '@polo-ai/shared/admin'
import type { ProductSpaceAppRuntimeStartResult } from '@polo-ai/shared/protocol'
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
}
const stopExact = (handle: ProductSpaceAppRuntimeStartResult) => window.electronAPI.localApps.stop({
  kind: 'product_space_runtime_handle', executionId: handle.executionId,
  expectedRuntimeGeneration: handle.runtimeGeneration,
})

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
  const [closing, setClosing] = useState<OwnedApp | null>(null)
  const [closingEpoch, setClosingEpoch] = useState<object | null>(null)
  const [stopping, setStopping] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  // Insertion cleanup fences old completions before the next scope's layout effects.
  useInsertionEffect(() => {
    const token = {}; epoch.current = token
    return () => {
      if (epoch.current === token) epoch.current = null
      for (const record of records.current.values()) {
        if (record.handle) void stopExact(record.handle).catch(() => {})
      }
      records.current.clear()
    }
  }, [space?.accountId, space?.activeProductSpaceId, space?.contextVersion])

  useEffect(() => {
    setClosing(null); setClosingEpoch(null); setStopping(false); setCloseError(null)
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
        const record: OwnedApp = { starting: true, tab: {
          id: createTabId('product-space-app'), appId: context.artifactInstanceId,
          type: 'webapp', title: app.name, isLoading: true, productSpaceApp: { accountId: space.accountId, productSpaceId: space.activeProductSpaceId, contextVersion: space.contextVersion },
        } }
        records.current.set(key, record)
        reveal(record)
        try {
          if (pending.launch.delivery.kind === 'web_url') {
            record.tab.url = pending.launch.delivery.url
          } else {
            const handle = await window.electronAPI.localApps.start({
              kind: 'product_space_runtime_start', app: identityForProductSpaceApp(snapshot, app),
            }) as ProductSpaceAppRuntimeStartResult
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
      if (!record.handle) { store.set(closeTabAtom, tabId); return true }
      setCloseError(null); setStopping(false); setClosingEpoch(epoch.current); setClosing(record)
      return true
    })
    return () => registerProductSpaceTabClose?.(null)
  }, [registerProductSpaceTabClose, store, t])

  const stopAndClose = async () => {
    const target = closing; const token = closingEpoch
    if (!target?.handle || stopping || !token || token !== epoch.current) return
    setStopping(true); setCloseError(null)
    try {
      await stopExact(target.handle)
      if (token !== epoch.current) return
      target.handle = undefined
      target.tab.url = undefined
      target.tab.runtimeError = t('homeApps.runtimeTab.stopped')
      store.set(closeTabAtom, target.tab.id)
      setClosing(null)
    } catch (error) {
      if (token === epoch.current) setCloseError(error instanceof Error ? error.message : t('homeApps.runtimeTab.failed'))
    } finally { if (token === epoch.current) setStopping(false) }
  }
  const closingScope = closing?.tab.productSpaceApp
  const closingIsCurrent = closingScope?.accountId === space?.accountId
    && closingScope?.productSpaceId === space?.activeProductSpaceId
    && closingScope?.contextVersion === space?.contextVersion
  return <Dialog open={Boolean(closing && closingIsCurrent)} onOpenChange={open => { if (!open && !stopping) setClosing(null) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('homeApps.runtimeTab.closeTitle')}</DialogTitle><DialogDescription>{t('homeApps.runtimeTab.closeDescription')}</DialogDescription></DialogHeader>
      {closeError && <p role="alert">{closeError}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={stopping} onClick={() => setClosing(null)}>{t('common.cancel')}</Button>
        <Button variant="outline" disabled={stopping} onClick={() => {
          if (closing && closingEpoch === epoch.current) {
            closing.tab.background = true
            store.set(updateTabInfoAtom, closing.tab)
            store.set(activeTabIdAtom, HOME_TAB_ID)
          }
          setClosing(null)
        }}>{t('homeApps.runtimeTab.background')}</Button>
        <Button disabled={stopping} onClick={() => void stopAndClose()}>{stopping ? t('common.loading') : t('homeApps.runtimeTab.stopAndClose')}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
