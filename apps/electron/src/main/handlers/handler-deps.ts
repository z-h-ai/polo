/**
 * HandlerDeps — dependency bag for all IPC handlers.
 *
 * Concrete Electron specialization of the generic server-core handler deps.
 */

import type { HandlerDeps as BaseHandlerDeps } from '@polo-ai/server-core/handlers'
import type { SessionManager } from '@polo-ai/server-core/sessions'
import type { WindowManager } from '../window-manager'
import type { BrowserPaneManager } from '../browser-pane-manager'

export type HandlerDeps = BaseHandlerDeps<
  SessionManager,
  WindowManager,
  BrowserPaneManager
>
