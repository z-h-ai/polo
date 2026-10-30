/**
 * FileLinkContextMenu - Right-click menu for file links rendered inside markdown.
 *
 * POO-173/FILELINK-01: exposes "reveal in file manager" and "copy file path" for
 * links that `resolveMarkdownLinkTarget` classified as filesystem targets. Web
 * URLs and plain text keep the browser-native context menu — only the anchor is
 * wrapped (FILELINK-02), so text selection and native copy affordances elsewhere
 * are untouched.
 *
 * Capability gating (POO-173 requirement): a menu item is rendered only when its
 * action is actually available, and the whole menu is skipped when neither is —
 * the anchor then keeps its native right-click behavior.
 *
 * The `path` passed here is a display-layer value (already stripped from
 * `file:` URLs by the shared resolver). It is only forwarded to the platform
 * actions below — it never flows back into message/tool/event payloads.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Check, FolderOpen } from 'lucide-react'
import { usePlatform, type PlatformActions } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

export interface FileLinkContextMenuProps {
  /** Filesystem path the menu acts on (display value only, never persisted) */
  path: string
  /** The interactive element the menu attaches to (the rendered anchor) */
  children: ReactNode
}

/** Platform actions the file-link menu depends on. */
export type FileLinkMenuPlatformActions = Pick<
  PlatformActions,
  'onRevealInFinder' | 'onCopyToClipboard'
>

/** Which menu items can actually do something on this platform. */
export interface FileLinkMenuAvailability {
  canReveal: boolean
  canCopy: boolean
}

/**
 * Renderer-native clipboard fallback. Every in-tree markdown copy affordance
 * (CodeBlock, CopyButton, TableExportDropdown, …) already writes through
 * `navigator.clipboard` directly; the Electron renderer provides no explicit
 * `onCopyToClipboard`, so without this fallback the "copy path" item would
 * never appear in the primary desktop surface (FILELINK-01 requires both
 * actions). Explicit platform implementations still win when provided.
 */
function hasRendererClipboard(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
}

/**
 * Capability gate for the two menu items. Kept pure so tests can drive it
 * without rendering: an item is only offered when its action exists, and a
 * platform without either action gets no menu at all (native right-click).
 */
export function resolveFileLinkMenuAvailability(
  actions: FileLinkMenuPlatformActions,
): FileLinkMenuAvailability {
  const canReveal = typeof actions.onRevealInFinder === 'function'
  const canCopy =
    typeof actions.onCopyToClipboard === 'function' || hasRendererClipboard()
  return { canReveal, canCopy }
}

export type FileLinkMenuActionResult = { ok: true } | { ok: false; error: unknown }

/**
 * Execute one of the two menu actions against the platform.
 *
 * - `reveal` fires the synchronous platform hook. Its contract is `void` —
 *   failures are owned by the platform wrapper, so the result reports `ok`.
 * - `copy` awaits the platform hook (or the renderer clipboard fallback) and
 *   reports a real `ok: false` on rejection so the caller can surface honest
 *   failure feedback instead of faking success.
 *
 * `path` is a display-layer value: it only ever flows outward to the platform
 * action, never back into message/tool/event payloads.
 */
export async function executeFileLinkMenuAction(
  action: 'reveal' | 'copy',
  path: string,
  actions: FileLinkMenuPlatformActions,
): Promise<FileLinkMenuActionResult> {
  if (action === 'reveal') {
    actions.onRevealInFinder?.(path)
    return { ok: true }
  }

  const copy = typeof actions.onCopyToClipboard === 'function'
    ? actions.onCopyToClipboard
    : navigator.clipboard.writeText.bind(navigator.clipboard)
  try {
    await copy(path)
    return { ok: true }
  } catch (error) {
    console.error('[FileLinkContextMenu] Failed to copy file path:', error)
    return { ok: false, error }
  }
}

// Menu styling mirrors the shared context-menu look already used by overlay
// header badges (FullscreenOverlayBaseHeader) — popover tokens, no new primitives.
const menuContentClasses = cn(
  'popover-styled z-dropdown min-w-40 overflow-hidden p-1',
  'w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5',
  'animate-in fade-in-0 zoom-in-95',
)

const menuItemClasses = cn(
  'relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0',
  'pr-4 rounded-[4px] hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]',
)

export function FileLinkContextMenu({ path, children }: FileLinkContextMenuProps) {
  const { t } = useTranslation()
  const platform = usePlatform()

  const { canReveal, canCopy } = resolveFileLinkMenuAvailability(platform)

  // Copy feedback lives inside the menu item. Radix checks
  // `event.defaultPrevented` synchronously after `onSelect` — long before the
  // async copy result exists — and ContextMenu.Root is uncontrolled (no `open`
  // prop), so `handleCopy` claims the close decision up front: the menu stays
  // open just long enough to show the honest outcome (✓ check on success,
  // inline "copy failed" on failure), then the user dismisses it as usual.
  // No fake success chrome, no swallowed errors (POO-173).
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimerRef = useRef<number | null>(null)

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  const scheduleCopyStateReset = useCallback(() => {
    clearResetTimer()
    // Self-heal while the menu stays open: restore the plain label so a retry
    // doesn't sit on a stale outcome state.
    resetTimerRef.current = window.setTimeout(() => {
      setCopyState('idle')
      resetTimerRef.current = null
    }, 1600)
  }, [clearResetTimer])

  useEffect(() => clearResetTimer, [clearResetTimer])

  const handleReveal = useCallback(() => {
    // Synchronous fire-and-forget: the reveal action hands off to the OS file
    // manager, so the menu closes immediately like any native item.
    void executeFileLinkMenuAction('reveal', path, platform)
  }, [path, platform])

  const handleCopy = useCallback((event: Event) => {
    event.preventDefault()
    void executeFileLinkMenuAction('copy', path, platform).then((result) => {
      setCopyState(result.ok ? 'copied' : 'failed')
      scheduleCopyStateReset()
    })
  }, [path, platform, scheduleCopyStateReset])

  if (!canReveal && !canCopy) {
    // No action available (e.g. restricted web viewer without clipboard access):
    // render the anchor untouched so right-click falls back to the native menu.
    return <>{children}</>
  }

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        // Reset the outcome state whenever the menu goes away — the next open
        // must show the plain action label again.
        if (!open) {
          clearResetTimer()
          setCopyState('idle')
        }
      }}
    >
      <ContextMenu.Trigger asChild>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClasses}>
          {canReveal && (
            <ContextMenu.Item className={menuItemClasses} onSelect={handleReveal}>
              <FolderOpen />
              {t('sessionMenu.showInFileManager', { fileManager: platform.fileManagerName || 'Finder' })}
            </ContextMenu.Item>
          )}
          {canCopy && (
            <ContextMenu.Item
              className={cn(menuItemClasses, copyState === 'failed' && 'text-destructive')}
              onSelect={handleCopy}
            >
              {copyState === 'copied' ? <Check className="text-success" /> : <Copy />}
              {copyState === 'failed' ? t('toast.copyFailed') : t('sessionMenu.copyPath')}
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
