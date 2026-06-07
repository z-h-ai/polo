import type { SessionExpiredEvent } from '@polo-ai/shared/auth'
import type { SessionDraft } from '@polo-ai/shared/config'

export interface RendererSessionExpiredFlowOptions {
  event: SessionExpiredEvent
  drafts: Map<string, SessionDraft>
  pendingDraftTimers: Map<string, ReturnType<typeof setTimeout>>
  setDraft: (sessionId: string, draft: SessionDraft) => Promise<void>
  dispatchEvent: (event: Event) => void
  showLoginPage: () => void
}

export async function handleRendererSessionExpired({
  event,
  drafts,
  pendingDraftTimers,
  setDraft,
  dispatchEvent,
  showLoginPage,
}: RendererSessionExpiredFlowOptions): Promise<void> {
  pendingDraftTimers.forEach(clearTimeout)
  pendingDraftTimers.clear()

  await Promise.all(
    Array.from(drafts.entries()).map(([sessionId, draft]) => setDraft(sessionId, draft)),
  )

  dispatchEvent(new CustomEvent('session-expired', { detail: event }))
  showLoginPage()
}
