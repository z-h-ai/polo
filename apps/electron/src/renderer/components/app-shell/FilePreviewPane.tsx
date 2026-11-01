import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, RotateCw } from 'lucide-react'
import { CodeBlock, FullscreenOverlayBaseHeader, CodePreviewOverlay, ImagePreviewOverlay, JSONPreviewOverlay, PDFPreviewOverlay, Markdown } from '@polo-ai/ui'
import type { FilePreviewState } from '@/hooks/useLinkInterceptor'

export interface FilePreviewPaneProps {
  state: FilePreviewState
  onClose: () => void
  onRetry: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  isDark: boolean
}

/** Ordinary files never enter the trusted canvas partition or receive its bridge. */
export function FilePreviewPane({ state, onClose, onRetry, loadDataUrl, loadPdfData, isDark }: FilePreviewPaneProps) {
  const { t } = useTranslation()
  const [source, setSource] = useState(false)
  const theme = isDark ? 'dark' : 'light'
  const common = { isOpen: true, embedded: true, onClose, filePath: state.filePath, theme } as const
  if (state.type === 'image') return <ImagePreviewOverlay {...common} loadDataUrl={loadDataUrl} />
  if (state.type === 'pdf') return <PDFPreviewOverlay {...common} loadPdfData={loadPdfData} />
  const text = state.content
  const code = state.type === 'code' || state.type === 'text'
  if (text !== null && !state.error && code) return <CodePreviewOverlay {...common} content={text} language={state.type === 'code' ? state.language : 'plaintext'} mode="read" />
  if (text !== null && !state.error && state.type === 'json') {
    try {
      const data: unknown = JSON.parse(text)
      if (data !== null && typeof data === 'object') return <JSONPreviewOverlay {...common} data={data} />
    } catch { /* Invalid JSON keeps its source available. */ }
    return <CodePreviewOverlay {...common} content={text} language="json" mode="read" />
  }
  return <div className="h-full min-h-0 flex flex-col" data-testid="file-preview-pane">
    <FullscreenOverlayBaseHeader onClose={onClose} filePath={state.filePath} headerActions={state.type === 'html' ? <button type="button" title={t('browserPane.sidebar.viewSource')} aria-pressed={source} onClick={() => setSource(!source)} className="p-1 rounded hover:bg-muted"><Code className="w-3.5 h-3.5" /></button> : undefined} />
    {text === null ? <div role="status" className="p-4 text-xs text-muted-foreground">{t('common.loading')}</div> : state.error ? <div role="alert" className="p-4 text-xs"><p>{state.error}</p><button type="button" onClick={onRetry} title={t('browserPane.sidebar.reload')} className="p-1 mt-2 rounded hover:bg-muted"><RotateCw className="w-4 h-4" /></button></div> : state.type === 'html' ?
      <div className="flex-1 min-h-0 relative">
        <iframe title={state.filePath} sandbox="allow-scripts" srcDoc={text} className="w-full h-full border-0 bg-white" style={{ visibility: source ? 'hidden' : undefined }} />
        {source && <div className="absolute inset-0 overflow-auto p-3"><CodeBlock code={text} language="html" forcedTheme={theme} /></div>}
      </div> :
      <div className="flex-1 overflow-auto p-4"><Markdown mode="minimal">{text}</Markdown></div>}
  </div>
}
