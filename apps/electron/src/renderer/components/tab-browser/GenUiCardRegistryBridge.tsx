/**
 * GenUiCardRegistryBridge - Electron-side consumer of the canvas card
 * registration events (POO-103).
 *
 * packages/ui's GenUiAppCard dispatches `craft:register-genui-card` /
 * `craft:unregister-genui-card` CustomEvents (it cannot import the Electron
 * API surface without a package cycle). This bridge forwards them to Main's
 * UiCardRegistry RPC. Main independently verifies every registration against
 * its own attach observations (webview-security), so a wrong or forged guest
 * id is rejected here's-upstream — the bridge is a courier, not an authority.
 */

import { useCallback, useEffect } from 'react'
import {
  GENUI_CARD_REGISTER_EVENT,
  GENUI_CARD_UNREGISTER_EVENT,
  type GenUiCardRegistration,
} from '@polo-ai/ui/chat/GenUiAppCard'

export function GenUiCardRegistryBridge() {
  const forward = useCallback(async (event: Event, channel: 'register' | 'unregister') => {
    const detail = (event as CustomEvent<GenUiCardRegistration>).detail
    if (!detail || typeof detail.sessionId !== 'string' || typeof detail.cardId !== 'string') return
    if (typeof detail.guestWebContentsId !== 'number') return
    try {
      if (channel === 'register') {
        await window.electronAPI.registerGenUiCard({
          sessionId: detail.sessionId,
          cardId: detail.cardId,
          guestWebContentsId: detail.guestWebContentsId,
        })
      } else {
        await window.electronAPI.unregisterGenUiCard({
          sessionId: detail.sessionId,
          cardId: detail.cardId,
        })
      }
    } catch {
      // A failed registration only means the card never gains ui-event
      // access — the next mount retries. Nothing user-visible to surface.
    }
  }, [])

  useEffect(() => {
    const registerListener = (event: Event) => void forward(event, 'register')
    const unregisterListener = (event: Event) => void forward(event, 'unregister')
    window.addEventListener(GENUI_CARD_REGISTER_EVENT, registerListener)
    window.addEventListener(GENUI_CARD_UNREGISTER_EVENT, unregisterListener)
    return () => {
      window.removeEventListener(GENUI_CARD_REGISTER_EVENT, registerListener)
      window.removeEventListener(GENUI_CARD_UNREGISTER_EVENT, unregisterListener)
    }
  }, [forward])

  return null
}
