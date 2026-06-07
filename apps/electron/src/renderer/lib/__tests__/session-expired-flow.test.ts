import { describe, expect, it, mock } from 'bun:test'
import type { SessionDraft } from '@polo-ai/shared/config'
import { handleRendererSessionExpired } from '../session-expired-flow'

describe('renderer session expired flow', () => {
  it('flushes current unsent drafts, emits a browser event, and routes to LoginPage state', async () => {
    const drafts = new Map<string, SessionDraft>([
      ['session-active', { text: 'unsent message' }],
    ])
    const setDraft = mock(async (_sessionId: string, _draft: SessionDraft) => {})
    const showLoginPage = mock(() => {})
    const dispatched: Event[] = []

    await handleRendererSessionExpired({
      event: { reason: 'token_revoked', requestUrl: 'http://admin.example.test/api/quota/check' },
      drafts,
      pendingDraftTimers: new Map(),
      setDraft,
      dispatchEvent: event => {
        dispatched.push(event)
      },
      showLoginPage,
    })

    expect(setDraft).toHaveBeenCalledWith('session-active', { text: 'unsent message' })
    expect(showLoginPage).toHaveBeenCalledTimes(1)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.type).toBe('session-expired')
  })
})
