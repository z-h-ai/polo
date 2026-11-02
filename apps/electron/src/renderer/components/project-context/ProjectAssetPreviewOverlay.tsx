import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, RotateCw } from 'lucide-react'
import { CodeBlock, FullscreenOverlayBaseHeader } from '@polo-ai/ui'
import { useRegisterModal } from '@/context/ModalContext'
import type { FilePreviewState } from '@/hooks/useLinkInterceptor'

/**
 * The project file HTML preview overlay (POO-196, consensus S-10 + X20).
 *
 * Isolation contract (adjudication D3.1.7): a shared project file is
 * UNTRUSTED content. The document is rendered from `srcDoc` into a frame whose
 * sandbox keeps only `allow-scripts`, and a Content-Security-Policy `<meta>` is
 * injected as the first node of the document's own `<head>` (see
 * {@link hardenProjectPreviewHtml}) — a page cannot relax a policy that arrived
 * before it (browsers intersect policies, so a later `<meta>` can only tighten
 * it). The policy allows self-contained HTML to render (inline markup, inline
 * styles, inline scripts, data:/blob: images) and denies everything else —
 * remote fetch, images, frames, fonts, forms and base URLs all fall back to
 * `default-src 'none'`.
 *
 * An inline bootstrap script additionally blocks the vectors CSP cannot see:
 * `window.open`, `target=_blank/_top` link activation, form submits and
 * parent/top navigation attempts. Self-navigation of the frame itself has no
 * CSP lever, so link activation is prevented at the source.
 *
 * Chrome (consensus X20): Esc closes (via useRegisterModal + a keydown
 * listener), focus moves into the overlay on open and returns to the trigger
 * on close, and the overlay floats on the z-modal token instead of a raw
 * z-40 absolute layer.
 */

/** The policy string injected into every project HTML preview. */
export const PC_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * Blocks the navigation/pop-up vectors a CSP cannot express. Runs first in the
 * document (injected before the content), so the page's own handlers can never
 * win the race.
 */
const PC_PREVIEW_GUARD_SCRIPT = `
(function () {
  try {
    window.open = function () {
      console.error('[preview-guard] window.open blocked');
      return null;
    };
    document.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== document) {
        if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) {
          event.preventDefault();
          event.stopPropagation();
          console.error('[preview-guard] link navigation blocked');
          return;
        }
        node = node.parentNode;
      }
    }, true);
    document.addEventListener('submit', function (event) {
      event.preventDefault();
      event.stopPropagation();
      console.error('[preview-guard] form submit blocked');
    }, true);
    document.addEventListener('auxclick', function (event) {
      if (event.button === 1) {
        event.preventDefault();
        event.stopPropagation();
        console.error('[preview-guard] middle-click navigation blocked');
      }
    }, true);
  } catch (error) {
    console.error('[preview-guard] init failed: ' + String(error));
  }
})();
`

/**
 * Hardens untrusted HTML: the policy `<meta>` and the guard script are
 * injected as the FIRST nodes of the document's OWN `<head>` (via DOMParser,
 * which never executes scripts or loads subresources), so a shared file that
 * ships a complete `<!doctype html><html><head>…` document keeps its shape and
 * cannot push our policy out of the head — browsers ignore CSP metas found in
 * the body, and intersect policies that do apply, so a page cannot relax one
 * that arrived before it.
 */
export function hardenProjectPreviewHtml(content: string): string {
  // A leading byte-order mark would precede the doctype and confuse parsing.
  const doc = new DOMParser().parseFromString(content.replace(/^﻿/, ''), 'text/html')
  const head = doc.head
  if (head) {
    const guard = doc.createElement('script')
    guard.textContent = PC_PREVIEW_GUARD_SCRIPT
    const meta = doc.createElement('meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', PC_PREVIEW_CSP)
    head.insertBefore(meta, head.firstChild)
    // The guard is the second head node: it executes before any body script,
    // so the page's own handlers can never win the race.
    if (meta.nextSibling) head.insertBefore(guard, meta.nextSibling)
    else head.appendChild(guard)
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

export interface ProjectAssetPreviewOverlayProps {
  state: FilePreviewState
  isDark: boolean
  onClose: () => void
  onRetry: () => void
}

export function ProjectAssetPreviewOverlay({ state, isDark, onClose, onRetry }: ProjectAssetPreviewOverlayProps) {
  const { t } = useTranslation()
  const [source, setSource] = useState(false)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const restoreRef = React.useRef<HTMLElement | null>(null)
  const theme = isDark ? 'dark' : 'light'
  // This overlay is only ever fed the surface's own html preview state; the
  // union narrows here so the other preview kinds cannot reach srcDoc.
  const html = state.type === 'html' ? state : null
  const text = html?.content ?? null

  // Esc + layered close (consensus X20), same contract as ConfirmDialog.
  useRegisterModal(true, onClose)

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  // Focus enters the overlay on open and returns to the trigger on close.
  React.useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null
    containerRef.current?.focus()
    return () => {
      restoreRef.current?.focus?.()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      // Fixed to the pane's viewport with the z-modal token (consensus X20):
      // the previous `absolute inset-0 z-40` resolved against whatever ancestor
      // happened to be positioned and stacked below real modals.
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t('projectContext.preview.ariaLabel')}
      className="fixed inset-0 z-modal flex min-h-0 flex-col bg-background outline-none"
      data-testid="pc-preview-overlay"
    >
      <FullscreenOverlayBaseHeader
        onClose={onClose}
        filePath={state.filePath}
        headerActions={(
          <button
            type="button"
            title={t('browserPane.sidebar.viewSource')}
            aria-pressed={source}
            onClick={() => setSource(!source)}
            className="rounded p-1 hover:bg-muted"
            data-testid="pc-preview-source-toggle"
          >
            <Code className="h-3.5 w-3.5" />
          </button>
        )}
      />
      {text === null ? (
        <div role="status" className="p-4 text-xs text-muted-foreground">{t('common.loading')}</div>
      ) : html?.error ? (
        <div role="alert" className="p-4 text-xs">
          <p>{html.error}</p>
          <button
            type="button"
            onClick={onRetry}
            title={t('browserPane.sidebar.reload')}
            className="mt-2 rounded p-1 hover:bg-muted"
            data-testid="pc-preview-retry"
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <iframe
            title={state.filePath}
            // Sandboxing keeps scripts only: no same-origin access, no popups,
            // no top navigation, no forms (consensus S-10).
            sandbox="allow-scripts"
            srcDoc={hardenProjectPreviewHtml(text)}
            className="h-full w-full border-0 bg-white"
            style={{ visibility: source ? 'hidden' : undefined }}
            data-testid="pc-preview-frame"
          />
          {source && (
            <div className="absolute inset-0 overflow-auto p-3" data-testid="pc-preview-source">
              <CodeBlock code={text} language="html" forcedTheme={theme} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
