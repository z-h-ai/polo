import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTabShell } from '@/context/TabShellContext'
import type { TabInstance } from '../../../shared/tab-browser-types'

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

function readWebviewBoolean(webview: WebviewElement, method: 'canGoBack' | 'canGoForward'): boolean {
  try {
    return Boolean(webview[method]?.())
  } catch {
    return false
  }
}

function callWebviewMethod(webview: WebviewElement | null, method: 'goBack' | 'goForward' | 'reload' | 'stop') {
  try {
    webview?.[method]?.()
  } catch {
    // Electron webview methods can throw when the guest is not ready or was destroyed.
  }
}

export function WebAppView({ tab }: WebAppViewProps) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const { registerWebAppNavigation, updateTabInfo } = useTabShell()
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    let isDomReady = false
    const updateNavigationState = () => {
      if (!isDomReady) {
        setCanGoBack(false)
        setCanGoForward(false)
        return
      }
      setCanGoBack(readWebviewBoolean(webview, 'canGoBack'))
      setCanGoForward(readWebviewBoolean(webview, 'canGoForward'))
    }
    const domReady = () => {
      isDomReady = true
      updateNavigationState()
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

    webview.addEventListener('dom-ready', domReady)
    webview.addEventListener('did-start-loading', startLoading)
    webview.addEventListener('did-stop-loading', stopLoading)
    webview.addEventListener('did-navigate', updateNavigationState)
    webview.addEventListener('did-navigate-in-page', updateNavigationState)
    webview.addEventListener('page-title-updated', titleUpdated)
    webview.addEventListener('page-favicon-updated', faviconUpdated)
    webview.addEventListener('new-window', newWindow)
    setCanGoBack(false)
    setCanGoForward(false)

    return () => {
      webview.removeEventListener('dom-ready', domReady)
      webview.removeEventListener('did-start-loading', startLoading)
      webview.removeEventListener('did-stop-loading', stopLoading)
      webview.removeEventListener('did-navigate', updateNavigationState)
      webview.removeEventListener('did-navigate-in-page', updateNavigationState)
      webview.removeEventListener('page-title-updated', titleUpdated)
      webview.removeEventListener('page-favicon-updated', faviconUpdated)
      webview.removeEventListener('new-window', newWindow)
    }
  }, [tab.id, updateTabInfo])

  const goBack = useCallback(() => {
    callWebviewMethod(webviewRef.current, 'goBack')
  }, [])

  const goForward = useCallback(() => {
    callWebviewMethod(webviewRef.current, 'goForward')
  }, [])

  const reloadOrStop = useCallback(() => {
    callWebviewMethod(webviewRef.current, tab.isLoading ? 'stop' : 'reload')
  }, [tab.isLoading])

  const navigationControls = useMemo(() => ({
    canGoBack,
    canGoForward,
    isLoading: Boolean(tab.isLoading),
    goBack,
    goForward,
    reloadOrStop,
  }), [canGoBack, canGoForward, goBack, goForward, reloadOrStop, tab.isLoading])

  useEffect(() => {
    registerWebAppNavigation(tab.id, navigationControls)
    return () => registerWebAppNavigation(tab.id, null)
  }, [navigationControls, registerWebAppNavigation, tab.id])

  const url = tab.url || ''

  return (
    <div className="h-full min-h-0 bg-background">
      <webview
        ref={webviewRef as RefObject<any>}
        src={url}
        partition="persist:browser-pane"
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        className="h-full w-full"
      />
    </div>
  )
}
