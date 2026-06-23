import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTabShell } from '@/context/TabShellContext'
import type { TabInstance } from '../../../shared/tab-browser-types'
import { WebAppToolbar } from './WebAppToolbar'

interface WebAppViewProps {
  tab: TabInstance
}

type WebviewElement = HTMLElement & {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  stop?: () => void
}

export function WebAppView({ tab }: WebAppViewProps) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const { updateTabInfo } = useTabShell()
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const updateNavigationState = () => {
      setCanGoBack(Boolean(webview.canGoBack?.()))
      setCanGoForward(Boolean(webview.canGoForward?.()))
    }
    const startLoading = () => updateTabInfo({ id: tab.id, isLoading: true })
    const stopLoading = () => {
      updateTabInfo({ id: tab.id, isLoading: false })
      updateNavigationState()
    }
    const titleUpdated = (event: Event) => {
      const title = (event as any).title as string | undefined
      if (title) updateTabInfo({ id: tab.id, title })
    }
    const faviconUpdated = (event: Event) => {
      const favicons = (event as any).favicons as string[] | undefined
      if (favicons?.[0]) updateTabInfo({ id: tab.id, favicon: favicons[0] })
    }
    const newWindow = (event: Event) => {
      event.preventDefault()
      const url = (event as any).url as string | undefined
      if (url) void window.electronAPI.openUrl(url)
    }

    webview.addEventListener('did-start-loading', startLoading)
    webview.addEventListener('did-stop-loading', stopLoading)
    webview.addEventListener('did-navigate', updateNavigationState)
    webview.addEventListener('did-navigate-in-page', updateNavigationState)
    webview.addEventListener('page-title-updated', titleUpdated)
    webview.addEventListener('page-favicon-updated', faviconUpdated)
    webview.addEventListener('new-window', newWindow)

    return () => {
      webview.removeEventListener('did-start-loading', startLoading)
      webview.removeEventListener('did-stop-loading', stopLoading)
      webview.removeEventListener('did-navigate', updateNavigationState)
      webview.removeEventListener('did-navigate-in-page', updateNavigationState)
      webview.removeEventListener('page-title-updated', titleUpdated)
      webview.removeEventListener('page-favicon-updated', faviconUpdated)
      webview.removeEventListener('new-window', newWindow)
    }
  }, [tab.id, updateTabInfo])

  const url = tab.url || ''

  return (
    <div className="h-full min-h-0 bg-background">
      <WebAppToolbar
        url={url}
        favicon={tab.favicon}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={Boolean(tab.isLoading)}
        onBack={() => webviewRef.current?.goBack?.()}
        onForward={() => webviewRef.current?.goForward?.()}
        onReload={() => {
          if (tab.isLoading) webviewRef.current?.stop?.()
          else webviewRef.current?.reload?.()
        }}
      />
      <webview
        ref={webviewRef as RefObject<any>}
        src={url}
        partition="persist:browser-pane"
        allowpopups={false}
        webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
        className="h-full w-full"
      />
    </div>
  )
}
