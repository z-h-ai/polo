import { describe, expect, it } from 'bun:test'
import {
  createMainWindowWithOutcome,
  DEFAULT_NEW_WINDOW_SHOW_TIMEOUT_MS,
  type LaunchableWindow,
  type NewWindowLaunchDeps,
} from '../new-window-launch'

/**
 * POO-117 P117-07 — the new-main-window request must never silently no-op.
 *
 * Four silent-return paths existed before this module (missing windowManager,
 * unresolved workspace, missing webContentsId mapping, ready-to-show never
 * firing). Each is now an observable, diagnosable outcome.
 */

function makeFakeWindow(overrides: Partial<LaunchableWindow> = {}): LaunchableWindow & {
  readyToShow: () => void
  focusCalls: number
  waitForWorkbenchReady: (signal: AbortSignal) => Promise<boolean>
} {
  let readyListener: (() => void) | null = null
  let ready: (() => void) | null = null
  let focused = false
  let visible = false
  let destroyed = false
  const win = {
    webContents: { id: 42 },
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isVisible: () => visible,
    show: () => { visible = true },
    destroy: () => { destroyed = true },
    focus: () => { win.focusCalls++; focused = true },
    once: (event: string, listener: () => void) => {
      if (event === 'ready-to-show') readyListener = listener
    },
    focusCalls: 0,
    readyToShow: () => { readyListener?.(); ready?.() },
    waitForWorkbenchReady: (signal: AbortSignal) => new Promise<boolean>((resolve) => {
      ready = () => resolve(true)
      signal.addEventListener('abort', () => resolve(false), { once: true })
    }),
    ...overrides,
  }
  return win
}

function makeDeps(win: ReturnType<typeof makeFakeWindow> | null): NewWindowLaunchDeps & { logs: string[] } {
  const logs: string[] = []
  return {
    createWindow: win
      ? () => win as unknown as LaunchableWindow
      : null,
    waitForWorkbenchReady: (window, signal) => (window as typeof win & NonNullable<typeof win>).waitForWorkbenchReady(signal),
    log: {
      info: (msg) => logs.push(String(msg)),
      warn: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(String(msg)),
    },
    logs,
  }
}

describe('createMainWindowWithOutcome (POO-117 P117-05/P117-07)', () => {
  it('fails observably when no window manager exists (was: silent return)', async () => {
    const deps = makeDeps(null)
    const result = await createMainWindowWithOutcome(deps, { source: 'renderer' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('window_manager_missing')
    expect(result.diagnostics.created).toBe(false)
    expect(deps.logs.join('\n')).toContain('window_manager_missing')
  })

  it('fails observably when the workspace cannot be resolved (was: silent return)', async () => {
    const win = makeFakeWindow()
    const deps = makeDeps(win)
    const result = await createMainWindowWithOutcome(deps, { source: 'renderer', workspaceId: null })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('workspace_unresolved')
    // The window factory must never run without a workspace — the old bug
    // dropped the request AFTER this guard, so nothing observable happened.
    expect(result.diagnostics.created).toBe(false)
  })

  it('fails observably when window construction throws', async () => {
    const logs: string[] = []
    const deps: NewWindowLaunchDeps & { logs: string[] } = {
      createWindow: () => { throw new Error('BrowserWindow constructor failed') },
      waitForWorkbenchReady: async () => false,
      log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
      logs,
    }
    const result = await createMainWindowWithOutcome(deps, { source: 'native_menu', workspaceId: 'ws-1' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('create_failed')
    expect(result.diagnostics.source).toBe('native_menu')
    expect(result.diagnostics.workspaceResolved).toBe(true)
    expect(result.diagnostics.created).toBe(false)
  })

  it('succeeds once ready-to-show fires, records diagnostics and focuses the window', async () => {
    const win = makeFakeWindow()
    const deps = makeDeps(win)
    const pending = createMainWindowWithOutcome(deps, { source: 'renderer', workspaceId: 'ws-1' })
    // ready-to-show fires asynchronously, mirroring the real BrowserWindow.
    await new Promise((resolve) => setTimeout(resolve, 5))
    win.readyToShow()
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.windowId).toBe(42)
    expect(result.diagnostics.created).toBe(true)
    expect(result.diagnostics.visible).toBe(true)
    expect(win.focusCalls).toBe(1)
  })

  it('fails with show_timeout instead of waiting forever when ready-to-show never fires', async () => {
    const win = makeFakeWindow()
    const deps = makeDeps(win)
    const result = await createMainWindowWithOutcome(deps, {
      source: 'webview_shortcut',
      workspaceId: 'ws-1',
      showTimeoutMs: 20,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('show_timeout')
    // Window object exists but never became visible — diagnostics must show
    // created:true / visible:false so the failure is attributable.
    expect(result.diagnostics.created).toBe(true)
    expect(result.diagnostics.visible).toBe(false)
  })

  it('does not focus an already-focused or destroyed window', async () => {
    const win = makeFakeWindow({ isFocused: () => true })
    const deps = makeDeps(win)
    const pending = createMainWindowWithOutcome(deps, { source: 'renderer', workspaceId: 'ws-1' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    win.readyToShow()
    await pending
    expect(win.focusCalls).toBe(0)
  })

  it('exposes a finite default show timeout (no unbounded waiting)', () => {
    expect(DEFAULT_NEW_WINDOW_SHOW_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_NEW_WINDOW_SHOW_TIMEOUT_MS)).toBe(true)
  })

  it('passes the sealed launch identity to the new window, independently of runtime workspace', async () => {
    const win = makeFakeWindow()
    const deps = makeDeps(win)
    let received: unknown
    deps.createWindow = (options) => { received = options; return win }
    const launchContext = { accountId: 'account-a', productSpaceId: 'enterprise-a' }
    const pending = createMainWindowWithOutcome(deps, { source: 'renderer', workspaceId: 'runtime-1', launchContext })
    win.readyToShow()
    expect((await pending).ok).toBe(true)
    expect(received).toEqual({ workspaceId: 'runtime-1', launchContext, showWhenReady: false })
  })

  it('does not report first paint as success before the real workbench acknowledges readiness', async () => {
    const win = makeFakeWindow()
    const deps = makeDeps(win)
    let acknowledge: (ready: boolean) => void = () => {}
    deps.waitForWorkbenchReady = () => new Promise(resolve => { acknowledge = resolve })
    let settled = false
    const pending = createMainWindowWithOutcome(deps, { source: 'renderer', workspaceId: 'ws-1', showTimeoutMs: 100 })
      .then(result => { settled = true; return result })
    win.readyToShow()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    acknowledge(true)
    expect((await pending).ok).toBe(true)
  })

  it('terminates an unready owned window before allowing retry, so late load cannot show a duplicate', async () => {
    const win = makeFakeWindow()
    const result = await createMainWindowWithOutcome(makeDeps(win), { source: 'renderer', workspaceId: 'ws-1', showTimeoutMs: 5 })
    expect(result.reason).toBe('show_timeout')
    expect(win.isDestroyed()).toBe(true)
    win.readyToShow()
    expect(win.isVisible()).toBe(false)
  })

  it('does not report success when focus is refused', async () => {
    const win = makeFakeWindow({ isFocused: () => false })
    const pending = createMainWindowWithOutcome(makeDeps(win), { source: 'renderer', workspaceId: 'ws-1' })
    win.readyToShow()
    expect((await pending).ok).toBe(false)
    expect(win.isDestroyed()).toBe(true)
  })

  it('does not report success when show fails or the window has already closed', async () => {
    for (const overrides of [{ isVisible: () => false }, { isDestroyed: () => true }]) {
      const win = makeFakeWindow(overrides)
      const pending = createMainWindowWithOutcome(makeDeps(win), { source: 'renderer', workspaceId: 'ws-1' })
      win.readyToShow()
      expect((await pending).ok).toBe(false)
    }
  })

  it('returns a typed failure and destroys the target if showing throws', async () => {
    const win = makeFakeWindow({ show: () => { throw new Error('show failed') } })
    const pending = createMainWindowWithOutcome(makeDeps(win), { source: 'renderer', workspaceId: 'ws-1' })
    win.readyToShow()
    expect((await pending).ok).toBe(false)
    expect(win.isDestroyed()).toBe(true)
  })

  it('finishes its outcome before the default transport timeout', () => {
    expect(DEFAULT_NEW_WINDOW_SHOW_TIMEOUT_MS).toBeLessThan(30_000)
  })
})
