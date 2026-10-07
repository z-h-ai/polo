import { useCallback, useEffect, useRef } from 'react'
import type { Workspace } from '../../shared/types'

/** A successful authentication receipt, owned by the still-current login intent. */
export interface AdminAuthCompletionIntent {
  accountId: string
  isCurrent: () => boolean
}

interface CompletionOptions {
  getSessionEpoch: () => number
  refreshUser: (intent: AdminAuthCompletionIntent) => Promise<{ userId?: string } | null>
  loadWorkspaces: () => Promise<Workspace[]>
  switchWorkspace: (id: string) => Promise<void>
  publishWorkspaces: (workspaces: Workspace[], selectedId: string | null) => void
  route: (accountId: string, workspaceId: string | null, isCurrent: () => boolean) => Promise<void>
  onPreparing: () => void
  onSessionMissing: () => void
  onFailure: (error: unknown) => void
}

/** Initializes the existing App route. Retrying never repeats login or sends a code. */
export function useAdminAuthCompletion(options: CompletionOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const attemptRef = useRef<object | null>(null)
  const pendingRef = useRef(false)
  const retryIntentRef = useRef<AdminAuthCompletionIntent | null>(null)

  const cancel = useCallback(() => {
    attemptRef.current = null
    pendingRef.current = false
    retryIntentRef.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  const start = useCallback(async (intent: AdminAuthCompletionIntent) => {
    if (!intent.isCurrent()) return
    const attempt = {}
    attemptRef.current = attempt
    pendingRef.current = true
    retryIntentRef.current = null
    const current = optionsRef.current
    const sessionEpoch = current.getSessionEpoch()
    const isCurrent = () => (
      attemptRef.current === attempt
      && current.getSessionEpoch() === sessionEpoch
      && intent.isCurrent()
    )
    const guardedIntent = { accountId: intent.accountId, isCurrent }
    current.onPreparing()
    try {
      const user = await current.refreshUser(guardedIntent)
      if (!isCurrent()) return
      if (user?.userId !== intent.accountId) {
        current.onSessionMissing()
        return
      }
      const workspaces = await current.loadWorkspaces()
      if (!isCurrent()) return
      const workspaceId = workspaces[0]?.id ?? null
      if (workspaceId) {
        await current.switchWorkspace(workspaceId)
        if (!isCurrent()) return
      }
      current.publishWorkspaces(workspaces, workspaceId)
      await current.route(intent.accountId, workspaceId, isCurrent)
    } catch (error) {
      if (!isCurrent()) return
      retryIntentRef.current = {
        accountId: intent.accountId,
        isCurrent: () => current.getSessionEpoch() === sessionEpoch && intent.isCurrent(),
      }
      current.onFailure(error)
    } finally {
      if (attemptRef.current === attempt) pendingRef.current = false
    }
  }, [])

  const retry = useCallback(() => {
    if (pendingRef.current) return true
    const intent = retryIntentRef.current
    if (!intent?.isCurrent()) return false
    // Keep the original authentication fence, not the old read attempt's identity.
    retryIntentRef.current = null
    void start({ accountId: intent.accountId, isCurrent: intent.isCurrent })
    return true
  }, [start])

  return { start, retry, cancel }
}
