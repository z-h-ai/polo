/** Creates an owned main window only after its verified workbench is ready. */
import type { NewWindowRequestSource, NewWindowResult, WorkbenchWindowContext } from '../shared/types'

export interface LaunchableWindow {
  webContents: { id: number }
  isDestroyed(): boolean
  isFocused(): boolean
  isVisible(): boolean
  show(): void
  focus(): void
  destroy(): void
  once(event: 'ready-to-show', listener: () => void): unknown
}

export type CreateWindowFn = (options: {
  workspaceId: string
  launchContext?: WorkbenchWindowContext
  showWhenReady: false
}) => LaunchableWindow

export interface NewWindowLaunchLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface NewWindowLaunchDeps {
  createWindow: CreateWindowFn | null
  waitForWorkbenchReady: (window: LaunchableWindow, signal: AbortSignal) => Promise<boolean>
  isContextCurrent?: () => boolean
  log: NewWindowLaunchLogger
}

export interface NewWindowLaunchOptions {
  workspaceId?: string | null
  launchContext?: WorkbenchWindowContext
  source: NewWindowRequestSource
  showTimeoutMs?: number
}

// Leave time for the response to reach the caller before the 30s RPC timeout.
export const DEFAULT_NEW_WINDOW_SHOW_TIMEOUT_MS = 20_000

export async function createMainWindowWithOutcome(
  deps: NewWindowLaunchDeps,
  options: NewWindowLaunchOptions,
): Promise<NewWindowResult> {
  const diagnostics = {
    source: options.source,
    workspaceId: options.workspaceId ?? null,
    workspaceResolved: Boolean(options.workspaceId),
    created: false,
    visible: false,
  }
  let win: LaunchableWindow | undefined
  let webContentsId: number | undefined
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const fail = (reason: NonNullable<NewWindowResult['reason']>): NewWindowResult => {
    // This target belongs exclusively to this request. Terminate an incomplete
    // target BEFORE releasing the request guard; a retry cannot leave a late,
    // invisible duplicate. Existing windows and their tasks are never touched.
    if (win && !win.isDestroyed()) win.destroy()
    deps.log.warn(`[new-window] failed: ${reason}`, { ...diagnostics, reason, webContentsId })
    return { ok: false, reason, windowId: webContentsId, webContentsId, diagnostics }
  }
  try {
    if (!deps.createWindow) return fail('window_manager_missing')
    if (!options.workspaceId) return fail('workspace_unresolved')
    if (deps.isContextCurrent && !deps.isContextCurrent()) return fail('scope_unavailable')
    deps.log.info('[new-window] creating', { source: options.source, workspaceId: options.workspaceId })
    win = deps.createWindow({ workspaceId: options.workspaceId, launchContext: options.launchContext, showWhenReady: false })
    webContentsId = win.webContents.id
    diagnostics.created = true
    const ready = await Promise.race([
      deps.waitForWorkbenchReady(win, abort.signal),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), options.showTimeoutMs ?? DEFAULT_NEW_WINDOW_SHOW_TIMEOUT_MS) }),
    ])
    if (!ready) return fail('show_timeout')
    if (deps.isContextCurrent && !deps.isContextCurrent()) return fail('scope_unavailable')
    if (win.isDestroyed()) return fail('show_failed')
    win.show()
    if (!win.isFocused()) win.focus()
    if (win.isDestroyed() || !win.isVisible() || !win.isFocused()) return fail('show_failed')
    diagnostics.visible = true
    deps.log.info('[new-window] workbench ready, visible and focused', { ...diagnostics, webContentsId })
    return { ok: true, windowId: webContentsId, webContentsId, diagnostics }
  } catch (error) {
    deps.log.error('[new-window] failed', { source: options.source, error })
    return fail(diagnostics.created ? 'show_failed' : 'create_failed')
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}
