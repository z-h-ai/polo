import { useCallback, useEffect, useRef } from 'react'
import { openBrowserLink } from '../lib/open-browser-link'

type BrowserLinkAPI = Parameters<typeof openBrowserLink>[0]
interface BrowserLinkScope {
  scopeKey: string | null | undefined
  sessionId: string | undefined
}

/** The App's chat-link browser callback, scoped to its current selection. */
export function useOpenBrowserLink(api: BrowserLinkAPI, scope: BrowserLinkScope) {
  const current = useRef({ ...scope, request: 0 })
  // Replace the identity at each selection boundary: A -> B -> A must not
  // revive a request from the first A, even inside the same ProductSpace.
  if (current.current.scopeKey !== scope.scopeKey || current.current.sessionId !== scope.sessionId) {
    current.current = { ...scope, request: 0 }
  }
  const owner = current.current
  useEffect(() => () => { current.current.request += 1 }, [])
  return useCallback(async (url: string) => {
    if (current.current !== owner) return
    const request = ++owner.request
    await openBrowserLink(api, url, {
      sessionId: owner.sessionId,
      isScopeCurrent: () => current.current === owner && owner.request === request,
    })
  }, [api, owner])
}
