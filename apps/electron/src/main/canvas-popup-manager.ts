/**
 * POO-135 验收修复 (SB-CANVAS-OUT): the canvas app's dedicated popup window.
 *
 * The right-sidebar canvas card is a renderer `<webview>`, which cannot
 * migrate across windows the way the browser pane's WebContentsView does —
 * so popping out creates a fresh BrowserWindow that loads the SAME carrier
 * contract (canvas-popout.html hosting a CanvasPaneCard: same ephemeral
 * `genui-app-<sessionId>` partition, same UiCardRegistry registration via
 * the shared useGenUiGuestWebview hook). The logical canvas — the app object
 * in the renderer's canvas-pane atoms — never moves; the sidebar and the
 * popup are two carriers of one canvas, mutually exclusive by the
 * `canvasPanePopout` atom the main window reconciles from our broadcasts.
 *
 * Window semantics (aligned with the browser pane where applicable):
 * - the popup registers into the WindowManager's workspace map (aux window)
 *   so Main's webview attach gate resolves the same trusted scope — an
 *   unmapped window is fail-closed for every `<webview>`;
 * - closing the window by ANY route (explicit「收回」or the system close
 *   button) emits `poppedOut:false` — the sidebar returns the canvas
 *   automatically (spec: system-close returns it, contents preserved; the
 *   canvas object is renderer state, so a fresh webview re-mounts on return);
 * - the title shows the app name and is never overridden by the workspace
 *   title policy (aux windows are not counted as main windows).
 */

import { BrowserWindow, app, nativeTheme } from 'electron'
import { join } from 'path'
import type { CanvasPaneApp, CanvasPanePopoutState } from '@polo-ai/shared/protocol'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/** Matches the prototype's popout dimensions (candidate review.html). */
const POPUP_DEFAULT_WIDTH = 880
const POPUP_DEFAULT_HEIGHT = 720
const POPUP_MIN_WIDTH = 480
const POPUP_MIN_HEIGHT = 360

interface CanvasPopupEntry {
  window: BrowserWindow
  app: CanvasPaneApp
  workspaceId: string | null
}

export class CanvasPopupManager {
  private popouts = new Map<string, CanvasPopupEntry>()
  private windowManager: WindowManager | null = null
  private stateListeners = new Set<(state: CanvasPanePopoutState) => void>()

  setWindowManager(windowManager: WindowManager | null): void {
    this.windowManager = windowManager
  }

  /** Renderer-side sync subscribes here (browser.ts forwards as a broadcast). */
  onStateChanged(listener: (state: CanvasPanePopoutState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  private emitState(sessionId: string, poppedOut: boolean, isVisible: boolean): void {
    const state: CanvasPanePopoutState = { sessionId, poppedOut, isVisible }
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state)
      } catch {
        // A dead listener must never break the others (app shutdown order).
      }
    }
  }

  detachToPopup(sessionId: string, app_: CanvasPaneApp, workspaceId: string | null | undefined): void {
    const existing = this.popouts.get(sessionId)
    if (existing && !existing.window.isDestroyed()) {
      // Mutual exclusion: one popup per session's canvas — re-request focuses.
      existing.window.show()
      existing.window.focus()
      return
    }
    this.popouts.delete(sessionId)

    // Match background to current OS theme to prevent black/white flash.
    const bgColor = nativeTheme.shouldUseDarkColors ? '#2b292e' : '#fafafb'
    const window = new BrowserWindow({
      width: POPUP_DEFAULT_WIDTH,
      height: POPUP_DEFAULT_HEIGHT,
      minWidth: POPUP_MIN_WIDTH,
      minHeight: POPUP_MIN_HEIGHT,
      show: false,
      title: app_.title,
      backgroundColor: bgColor,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'bootstrap-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The popup hosts the very same <webview> carrier contract.
        webviewTag: true,
      },
    })

    // Keep the app-name title; the carrier page's <title> must not override it.
    window.on('page-title-updated', (event) => event.preventDefault())

    // The popup is a terminal carrier: no nested window.open from it.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        window.show()
        this.emitState(sessionId, true, true)
      }
    })

    // ANY close route (system close button, explicit attachFromPopup, app
    // shutdown) funnels here: the canvas returns to the sidebar automatically.
    window.on('closed', () => {
      const entry = this.popouts.get(sessionId)
      if (entry?.window === window) this.popouts.delete(sessionId)
      this.windowManager?.unregisterAuxWindow(window.webContents.id)
      mainLog.info(`[canvas-popup] closed for session=${sessionId} — canvas returns to the sidebar`)
      this.emitState(sessionId, false, false)
    })

    // Register into the workspace map so the webview attach gate treats this
    // renderer as a member of the same trusted scope (aux: title policy skips
    // it and main-window counting ignores it).
    this.windowManager?.registerAuxWindow(window, workspaceId ?? null)

    this.popouts.set(sessionId, { window, app: app_, workspaceId: workspaceId ?? null })

    const appQuery = encodeURIComponent(JSON.stringify(app_))
    if (VITE_DEV_SERVER_URL) {
      void window.loadURL(`${VITE_DEV_SERVER_URL}/canvas-popout.html?sessionId=${encodeURIComponent(sessionId)}&app=${appQuery}`)
    } else {
      void window.loadFile(join(__dirname, 'renderer/canvas-popout.html'), {
        query: { sessionId, app: JSON.stringify(app_) },
      })
    }
    mainLog.info(`[canvas-popup] detached canvas to popup session=${sessionId} app=${app_.appId}`)
  }

  /** Return the canvas to the sidebar: close the popup window. */
  attachFromPopup(sessionId: string): void {
    const entry = this.popouts.get(sessionId)
    if (!entry || entry.window.isDestroyed()) {
      // Idempotent: no popup — make sure the sidebar state is reconciled.
      this.emitState(sessionId, false, false)
      return
    }
    entry.window.close()
  }

  /** Show + focus the popup window (sidebar「显示窗口」affordance). */
  focus(sessionId: string): void {
    const entry = this.popouts.get(sessionId)
    if (!entry || entry.window.isDestroyed()) return
    if (entry.window.isMinimized()) entry.window.restore()
    entry.window.show()
    entry.window.focus()
  }

  isPoppedOut(sessionId: string): boolean {
    const entry = this.popouts.get(sessionId)
    return Boolean(entry && !entry.window.isDestroyed())
  }

  /** App-quit cleanup: close every popup (broadcasts drive the sidebar back). */
  destroyAll(): void {
    for (const [sessionId, entry] of [...this.popouts]) {
      if (!entry.window.isDestroyed()) entry.window.close()
      this.popouts.delete(sessionId)
    }
  }
}

/** Guard for tests / headless import (no Electron runtime). */
export function isCanvasPopupSupported(): boolean {
  return typeof BrowserWindow !== 'undefined' && typeof app !== 'undefined'
}
