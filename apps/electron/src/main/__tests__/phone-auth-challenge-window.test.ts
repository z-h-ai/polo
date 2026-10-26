/**
 * POO-151 — PhoneAuthChallengeWindowManager state machine tests.
 *
 * Mocks the electron boundary (same discipline as canvas-popup.test.ts) and
 * covers: hidden-by-default creation (无感), delayed show as the interactive
 * fallback, flow-driven close, user close notification, navigation
 * allow-list (issuer origin + loopback callback only), popup denial,
 * replace-on-reopen, destroyAll, and the IPC entry URL guard.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

const createdWindows: any[] = []

// Loosely typed on purpose: these mocks fake the Electron boundary and get
// their internals poked/inspected freely (same discipline as canvas-popup).
function createMockWebContents(): any {
  const listeners: Record<string, Function[]> = {}
  return {
    id: Math.floor(Math.random() * 1_000_000) + 10,
    isDestroyed: mock(() => false),
    send: mock((_channel: string, ..._args: unknown[]) => {}),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]!.push(cb)
    },
    setWindowOpenHandler: mock((_handler: any) => {}),
    _listeners: listeners,
    _emit: (event: string, ...args: unknown[]) => {
      for (const cb of [...(listeners[event] || [])]) cb(...args)
    },
  }
}

function createMockWindow(opts?: any): any {
  const listeners: Record<string, Function[]> = {}
  const wc = createMockWebContents()
  const win: any = {
    webContents: wc,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]!.push(cb)
    },
    once: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]!.push(cb)
    },
    _emit: (event: string, ...args: unknown[]) => {
      for (const cb of [...(listeners[event] || [])]) cb(...args)
    },
    isDestroyed: mock(() => false),
    isVisible: mock(() => false),
    show: mock(() => {}),
    focus: mock(() => {}),
    close: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    loadURL: mock(async (_url: string) => {}),
    _ctorOpts: opts,
    _windowOpenHandler: null as (null | ((...args: unknown[]) => unknown)),
  }
  // setWindowOpenHandler lives on webContents in Electron. Plain function —
  // Bun mocks cannot have their implementation swapped after creation.
  wc.setWindowOpenHandler = (handler: any) => {
    win._windowOpenHandler = handler
  }
  return win
}

let fakeParent: any = null

mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    static fromWebContents = mock((_wc: unknown) => fakeParent)
    static getFocusedWindow = mock(() => null)
    static getAllWindows = mock(() => [])
    // Returning the literal (not Object.assign onto `this`) keeps the
    // closure-held `_windowOpenHandler` writes and the test's reads on ONE
    // object — assign-copy would split them.
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      createdWindows.push(win)
      return win
    }
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return { mainLog: stubLog, isDebugMode: false }
})

const { PhoneAuthChallengeWindowManager, validatePhoneAuthChallengeOpenRequest } = await import('../phone-auth-challenge-window')

const ISSUER_URL = 'https://challenge.example.com/issue?redirect_uri=http%3A%2F%2F127.0.0.1%3A6477%2Fphone-auth%2Fcallback&state=abc'

function createRequester() {
  return createMockWebContents()
}

beforeEach(() => {
  createdWindows.length = 0
  fakeParent = null
})

afterEach(() => {
  for (const win of createdWindows) win._emit('closed')
})

describe('PhoneAuthChallengeWindowManager (POO-151)', () => {
  it('creates a hidden, sandboxed, parentless-modal window and loads the issuer', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    const requester = createRequester()
    manager.open(requester, ISSUER_URL)

    expect(createdWindows.length).toBe(1)
    const win = createdWindows[0]!
    expect(win._ctorOpts.show).toBe(false)
    expect(win._ctorOpts.modal).toBe(false)
    expect(win._ctorOpts.webPreferences.nodeIntegration).toBe(false)
    expect(win._ctorOpts.webPreferences.contextIsolation).toBe(true)
    expect(win._ctorOpts.webPreferences.sandbox).toBe(true)
    expect(win._ctorOpts.webPreferences.preload).toBeUndefined()
    expect(win._windowOpenHandler).toBeTypeOf('function')
    expect(win._windowOpenHandler!()).toEqual({ action: 'deny' })
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(win.isVisible()).toBe(false)
  })

  it('surfaces the window only after the silent budget elapses', async () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 15 })
    manager.open(createRequester(), ISSUER_URL)
    const win = createdWindows[0]!
    expect(win.show).not.toHaveBeenCalled()

    await Bun.sleep(40)
    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('closes silently on flow-driven close before ever showing', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    const requester = createRequester()
    manager.open(requester, ISSUER_URL)
    manager.close()

    const win = createdWindows[0]!
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(win.show).not.toHaveBeenCalled()
    // The flow settled on its own — no spurious cancellation broadcast.
    expect(requester.send).not.toHaveBeenCalled()
  })

  it('notifies the requester when the user closes the window themselves', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    const requester = createRequester()
    manager.open(requester, ISSUER_URL)
    // System close button — destroy from outside the manager.
    createdWindows[0]!._emit('closed')

    expect(requester.send).toHaveBeenCalledWith('__phone-auth-challenge:closed')
  })

  it('cancels on off-contract navigation and allows issuer/callback origins', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    const requester = createRequester()
    manager.open(requester, ISSUER_URL)
    const win = createdWindows[0]!
    const navigate = (target: string) =>
      (win.webContents as any)._emit('will-navigate', { preventDefault: () => {} }, target)

    navigate('https://challenge.example.com/issue?step=2')
    navigate('http://127.0.0.1:6477/phone-auth/callback?code=x&state=y')
    expect(win.destroy).not.toHaveBeenCalled()

    navigate('https://evil.example.com/phish')
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(requester.send).toHaveBeenCalledWith('__phone-auth-challenge:closed')
  })

  it('cancels on off-contract main-frame redirects and allows issuer/callback origins', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    const requester = createRequester()
    manager.open(requester, ISSUER_URL)
    const win = createdWindows[0]!
    const redirect = (url: string, isMainFrame = true) => {
      const preventDefault = mock(() => {})
      win.webContents._emit('will-redirect', { url, isMainFrame, preventDefault }, url, false, isMainFrame)
      return preventDefault
    }

    expect(redirect('https://challenge.example.com/issue?step=2')).not.toHaveBeenCalled()
    expect(redirect('http://127.0.0.1:6477/phone-auth/callback?code=x&state=y')).not.toHaveBeenCalled()
    expect(redirect('https://other.example.com/frame', false)).not.toHaveBeenCalled()
    expect(win.destroy).not.toHaveBeenCalled()
    expect(requester.send).not.toHaveBeenCalled()

    expect(redirect('https://evil.example.com/phish')).toHaveBeenCalledTimes(1)
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(requester.send).toHaveBeenCalledWith('__phone-auth-challenge:closed')
    expect(requester.send).toHaveBeenCalledTimes(1)
  })

  it('replaces a previous challenge window and cancels the replaced requester', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    const first = createRequester()
    const second = createRequester()
    manager.open(first, ISSUER_URL)
    manager.open(second, ISSUER_URL)

    expect(createdWindows.length).toBe(2)
    expect(createdWindows[0]!.destroy).toHaveBeenCalledTimes(1)
    expect(first.send).toHaveBeenCalledWith('__phone-auth-challenge:closed')
    manager.close()
    // Only the replaced flow is cancelled; the current flow closes silently.
    expect(second.send).not.toHaveBeenCalled()
    expect(first.send).toHaveBeenCalledTimes(1)
  })

  it('ignores stale requester cleanup without closing or clearing the new window timer', async () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 15 })
    const first = createRequester()
    const second = createRequester()
    manager.open(first, ISSUER_URL)
    manager.open(second, ISSUER_URL)
    const currentWindow = createdWindows[1]!

    manager.close(first)
    expect(currentWindow.destroy).not.toHaveBeenCalled()
    expect(second.send).not.toHaveBeenCalled()
    await Bun.sleep(40)
    expect(currentWindow.show).toHaveBeenCalledTimes(1)

    manager.close(second)
    expect(currentWindow.destroy).toHaveBeenCalledTimes(1)
    expect(second.send).not.toHaveBeenCalled()
  })

  it('destroyAll is idempotent and clears every trace', () => {
    const manager = new PhoneAuthChallengeWindowManager({ showAfterMs: 60_000 })
    manager.open(createRequester(), ISSUER_URL)
    manager.destroyAll()
    manager.destroyAll()
    expect(createdWindows[0]!.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('validatePhoneAuthChallengeOpenRequest (POO-151)', () => {
  const valid = 'https://challenge.example.com/issue?redirect_uri=http%3A%2F%2F127.0.0.1%3A6477%2Fcb&state=x'

  it('accepts a bounded HTTPS issuer with a redirect_uri', () => {
    expect(validatePhoneAuthChallengeOpenRequest(valid).protocol).toBe('https:')
  })

  it('rejects non-HTTPS, credentialed, oversized and redirect-less URLs', () => {
    expect(() => validatePhoneAuthChallengeOpenRequest('http://challenge.example.com/issue?redirect_uri=http://x/cb')).toThrow('HTTPS')
    expect(() => validatePhoneAuthChallengeOpenRequest('https://user:secret@challenge.example.com/issue?redirect_uri=http://x/cb')).toThrow('HTTPS')
    expect(() => validatePhoneAuthChallengeOpenRequest(`https://challenge.example.com/${'a'.repeat(2100)}`)).toThrow('invalid')
    expect(() => validatePhoneAuthChallengeOpenRequest('https://challenge.example.com/issue')).toThrow('redirect_uri')
    expect(() => validatePhoneAuthChallengeOpenRequest(undefined)).toThrow('invalid')
  })
})
