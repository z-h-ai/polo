/**
 * Regression tests for the client active-session binding table.
 *
 * Bind: e2e acceptance 20261020 — deleting the active session left a stale
 * binding behind, so skills.GET/GET_FILES kept throwing
 * workspace_context_mismatch until restart. unbindClientActiveSession must
 * drop only the binding that actually points at the deleted session.
 */
import { describe, expect, it } from 'bun:test'
import {
  bindClientActiveSession,
  clearClientActiveSession,
  getClientActiveSession,
  unbindClientActiveSession,
} from '../client-active-session'

describe('client active-session binding', () => {
  it('returns the bound session only for the bound workspace', () => {
    clearClientActiveSession('client-a')
    bindClientActiveSession('client-a', 'ws-1', 'sess-1')
    expect(getClientActiveSession('client-a', 'ws-1')).toBe('sess-1')
    expect(getClientActiveSession('client-a', 'ws-2')).toBeNull()
  })

  it('unbind drops only the binding pointing at the deleted session', () => {
    clearClientActiveSession('client-b')
    clearClientActiveSession('client-c')
    bindClientActiveSession('client-b', 'ws-1', 'sess-del')
    bindClientActiveSession('client-c', 'ws-1', 'sess-keep')

    unbindClientActiveSession('client-b', 'sess-other')
    expect(getClientActiveSession('client-b', 'ws-1')).toBe('sess-del')

    unbindClientActiveSession('client-b', 'sess-del')
    expect(getClientActiveSession('client-b', 'ws-1')).toBeNull()
    expect(getClientActiveSession('client-c', 'ws-1')).toBe('sess-keep')

    unbindClientActiveSession('client-b', 'sess-del')
    expect(getClientActiveSession('client-b', 'ws-1')).toBeNull()
  })

  it('rebinding overwrites the previous session for the same client', () => {
    clearClientActiveSession('client-d')
    bindClientActiveSession('client-d', 'ws-1', 'sess-old')
    bindClientActiveSession('client-d', 'ws-1', 'sess-new')
    expect(getClientActiveSession('client-d', 'ws-1')).toBe('sess-new')
    unbindClientActiveSession('client-d', 'sess-old')
    expect(getClientActiveSession('client-d', 'ws-1')).toBe('sess-new')
    clearClientActiveSession('client-d')
  })
})
