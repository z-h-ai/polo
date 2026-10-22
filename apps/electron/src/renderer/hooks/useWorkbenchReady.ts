import { useEffect } from 'react'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { rendererLog } from '@/lib/logger'

/** Sent only by the mounted, hydrated workbench, after the main document loads. */
export function useWorkbenchReady(isHydrated: boolean) {
  const space = useOptionalProductSpaceContext()
  const accountId = space?.accountId
  const productSpaceId = space?.activeProductSpaceId
  const switching = Boolean(space?.pendingSwitch)
  useEffect(() => {
    const api = window.electronAPI
    if (!api.reportWorkbenchReady) return
    const ready = isHydrated && accountId && productSpaceId && !switching
    const report = () => {
      void api.reportWorkbenchReady(ready ? { accountId, productSpaceId } : null)
        .catch(error => rendererLog.warn('[workbench] readiness acknowledgement failed', error))
    }
    if (!ready || document.readyState === 'complete') report()
    else window.addEventListener('load', report, { once: true })
    return () => {
      window.removeEventListener('load', report)
      void api.reportWorkbenchReady(null).catch(() => {})
    }
  }, [isHydrated, accountId, productSpaceId, switching])
}
