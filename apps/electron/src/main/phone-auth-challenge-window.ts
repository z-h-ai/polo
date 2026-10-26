/**
 * POO-151 — in-app phone-auth challenge window.
 *
 * SMS login used to hand the challenge issuer URL to the system browser
 * (shell.openExternal) and wait for the loopback callback — a jarring
 * leave-the-app round trip. This manager hosts the very same issuer page in
 * an app-owned BrowserWindow instead, so the anti-abuse challenge still runs
 * unchanged (same provider page, same loopback callback contract) while the
 * user stays in Polo.
 *
 * Experience contract (card POO-151 Spec R1/R2):
 * - the window is created hidden; a non-interactive challenge completes in
 *   the background and the window closes before it was ever visible (无感);
 * - only if the challenge is still pending after `showAfterMs` does the
 *   window surface as a parented (non-modal — a hidden modal would freeze
 *   the login window with nothing on screen) child over the login window;
 * - ANY close route (flow-driven close, user close button, violation
 *   navigation, app quit) notifies the requesting renderer so the pending
 *   send-code flow can finish or cancel immediately.
 *
 * Security posture: the window loads EXTERNAL content, so it gets zero
 * bridge surface — no preload, contextIsolation, sandbox, no
 * window.open, and navigation is restricted to the issuer origin plus the
 * loopback callback (where the provider delivers the code). A navigation
 * elsewhere means the challenge was abandoned: close + notify (cancel).
 */

import { BrowserWindow } from 'electron'
import {
  PHONE_AUTH_CHALLENGE_CLOSED_CHANNEL,
} from '../shared/types'
import { mainLog } from './logger'

/** Challenges that resolve interactively need a compact, login-sized window. */
const CHALLENGE_WINDOW_WIDTH = 440
const CHALLENGE_WINDOW_HEIGHT = 600

export interface PhoneAuthChallengeWindowManagerOptions {
  /** How long a hidden challenge may run before surfacing its window. */
  showAfterMs?: number
}

/** What open() actually needs from the asking renderer (structural, testable). */
export interface PhoneAuthChallengeRequester {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export class PhoneAuthChallengeWindowManager {
  private window: BrowserWindow | null = null
  private requester: PhoneAuthChallengeRequester | null = null
  private issuerOrigin: string | null = null
  private callbackOrigin: string | null = null
  private showTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: PhoneAuthChallengeWindowManagerOptions = {}) {}

  private get showAfterMs(): number {
    return Math.max(0, this.options.showAfterMs ?? 2_500)
  }

  /**
   * Hosts `url` (the validated challenge issuer URL, loopback redirect_uri
   * already attached) for the renderer that asked. A previous window is
   * replaced: one challenge at a time, newest request wins.
   */
  open(requester: PhoneAuthChallengeRequester, url: string): void {
    const replaced = this.window && !this.window.isDestroyed() ? this.requester : null
    this.close()
    if (replaced) this.notifyClosed(replaced)

    const issuerUrl = new URL(url)
    const redirectUri = issuerUrl.searchParams.get('redirect_uri')
    this.issuerOrigin = issuerUrl.origin
    this.callbackOrigin = redirectUri ? new URL(redirectUri).origin : null

    // In production the requester is a real WebContents; the structural type
    // only narrows what open() depends on for testability.
    const parent = BrowserWindow.fromWebContents(requester as Electron.WebContents)
      ?? BrowserWindow.getFocusedWindow()
      ?? BrowserWindow.getAllWindows()[0]
      ?? undefined

    const window = new BrowserWindow({
      width: CHALLENGE_WINDOW_WIDTH,
      height: CHALLENGE_WINDOW_HEIGHT,
      parent,
      // Non-modal on purpose: hidden modal windows would freeze the login
      // window during the silent phase (see header comment).
      modal: false,
      show: false,
      title: '安全验证',
      autoHideMenuBar: true,
      // External content must not get any bridge surface at all.
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })
    this.window = window
    this.requester = requester

    // The challenge window hosts an external page; its own <title> is noise.
    window.on('page-title-updated', (event) => event.preventDefault())

    // Terminal window: nothing may be opened from the challenge page.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    // The provider may redirect within its own origin and MUST end at the
    // loopback callback. Anything else = abandoned challenge → cancel. This
    // close route is NOT flow-driven, so the pending flow must be told.
    const enforceNavigation = (event: Electron.Event, target: string) => {
      if (this.window !== window) return
      if (this.isAllowedNavigation(target)) return
      event.preventDefault()
      mainLog.warn('[phone-auth-challenge] blocked off-contract navigation — cancelling')
      const cancelled = this.requester
      this.close()
      if (cancelled) this.notifyClosed(cancelled)
    }
    window.webContents.on('will-navigate', enforceNavigation)
    window.webContents.on('will-redirect', (details) => {
      if (details.isMainFrame) enforceNavigation(details, details.url)
    })

    // A close from OUTSIDE the flow (system close button, teardown) funnels
    // here: notify the requester so the pending send-code flow stops waiting
    // (it treats this as a user cancellation). Flow-driven closes go through
    // close(), which nulls this.window first. Replacement explicitly cancels
    // the previous requester in open(); stale windows stay silent here.
    window.on('closed', () => {
      if (this.window !== window) return
      this.window = null
      this.clearShowTimer()
      this.notifyClosed(requester)
    })

    // 无感 phase: stay invisible; surface only if the challenge outlives the
    // silent budget (interactive fallback, spec R2).
    this.scheduleShow(window)

    void window.loadURL(url)
  }

  /** Flow-driven close (challenge finished or the flow gave up). Idempotent. */
  close(requester?: PhoneAuthChallengeRequester): void {
    if (requester && requester !== this.requester) return
    const window = this.window
    this.clearShowTimer()
    if (!window) return
    this.window = null
    this.requester = null
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }

  /** App-shutdown hook: no challenge window may outlive the app. */
  destroyAll(): void {
    this.close()
    this.requester = null
    this.issuerOrigin = null
    this.callbackOrigin = null
  }

  private scheduleShow(window: BrowserWindow): void {
    this.clearShowTimer()
    if (this.showAfterMs === 0) {
      window.show()
      return
    }
    this.showTimer = setTimeout(() => {
      this.showTimer = null
      if (this.window === window && !window.isDestroyed() && !window.isVisible()) {
        window.show()
      }
    }, this.showAfterMs)
  }

  private clearShowTimer(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer)
      this.showTimer = null
    }
  }

  private isAllowedNavigation(target: string): boolean {
    let targetUrl: URL
    try {
      targetUrl = new URL(target)
    } catch {
      return false
    }
    // The provider delivers the code via the loopback redirect_uri.
    if (this.callbackOrigin && targetUrl.origin === this.callbackOrigin) return true
    return this.issuerOrigin !== null && targetUrl.origin === this.issuerOrigin
  }

  private notifyClosed(requester: PhoneAuthChallengeRequester): void {
    this.requester = null
    if (!requester.isDestroyed()) {
      requester.send(PHONE_AUTH_CHALLENGE_CLOSED_CHANNEL)
    }
  }
}

/**
 * IPC entry guard: the renderer is an untrusted boundary. Only a validated
 * issuer URL (HTTPS, bounded length, no embedded credentials — the same rules
 * the preload enforces) may spawn a window. The loopback HTTP allowance is an
 * E2E-build-only capability on the preload side, and E2E builds never inject
 * this window path (they keep the `open-external` mock), so this guard stays
 * strict HTTPS. The loopback redirect_uri rides as a query param and is
 * allow-listed by origin in the manager, not here.
 */
export function validatePhoneAuthChallengeOpenRequest(url: unknown): URL {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) {
    throw new Error('Phone auth challenge URL is invalid')
  }
  const parsed = new URL(url)
  if (parsed.username || parsed.password || parsed.protocol !== 'https:') {
    throw new Error('Phone auth challenge URL must use HTTPS')
  }
  if (!parsed.searchParams.get('redirect_uri')) {
    throw new Error('Phone auth challenge URL lacks a redirect_uri')
  }
  return parsed
}
