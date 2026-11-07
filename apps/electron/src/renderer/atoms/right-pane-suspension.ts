/**
 * POO-196 R3 (adjudication D8, consensus P8): the project-members DRAWER is a
 * modal overlay, and Electron's native browser/canvas views are real
 * WebContentsViews layered ABOVE the window — CSS cannot cover them. While a
 * members drawer is open this flag asks the right-pane hosts to TEMPORARILY
 * withdraw the native views through their existing IPC visibility lifecycle
 * (`browserPane.unembed` / `canvasPane.hide`) WITHOUT destroying anything:
 * instances, URLs, canvas state and file-preview position all survive, and
 * closing the drawer restores them (re-embed / re-report bounds).
 *
 * Process-local, provider-store scoped (read with the ambient jotai store —
 * the same discipline as atoms/sidebar-browser.ts). This is a suspension
 * REASON, not a second instance manager: the embed/bounds lifecycle stays
 * owned by RightSidebarPane / CanvasPane.
 */
import { atom } from 'jotai'

export const rightPaneNativeSuspendAtom = atom(false)
