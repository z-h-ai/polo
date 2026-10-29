/**
 * POO-172 — open-citation-source helper.
 *
 * Covers the CITE-01/CITE-02 routing matrix and the async discipline:
 * legitimate https sources open in the built-in browserPane, dangerous
 * schemes are rejected without any fallback, file paths keep the file
 * preview, poloai deep links keep their existing channel, a late response
 * for a stale scope never steals the pane, and only the instance created by
 * a failed call is recycled.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({ settings: { navigator: { userAgent: 'test-agent' } } })
}

import {
  canReuseForCitationSource,
  createCitationSourceOpener,
  resolveCitationSourceTarget,
  type CitationSourceScope,
} from '../open-citation-source'
import type { BrowserInstanceInfo } from '../../../shared/types'

function makeInstance(overrides: Partial<BrowserInstanceInfo> = {}): BrowserInstanceInfo {
  return {
    id: 'inst-1',
    url: 'about:blank',
    title: '',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

type PaneCalls = {
  create: Array<Record<string, unknown>>
  navigate: Array<[string, string]>
  focus: Array<string>
  destroy: Array<string>
}

function installPane(overrides: {
  list?: () => Promise<BrowserInstanceInfo[]>
  create?: (input?: Record<string, unknown>) => Promise<string>
  navigate?: (id: string, url: string) => Promise<unknown>
  focus?: (id: string) => Promise<void>
  destroy?: (id: string) => Promise<void>
} = {}): PaneCalls {
  const calls: PaneCalls = { create: [], navigate: [], focus: [], destroy: [] }
  let nextId = 0
  const api = {
    list: overrides.list ?? (async () => []),
    create: overrides.create ?? (async (input?: Record<string, unknown>) => {
      calls.create.push(input ?? {})
      nextId += 1
      return `created-${nextId}`
    }),
    navigate: overrides.navigate ?? (async (id: string, url: string) => {
      calls.navigate.push([id, url])
      return { url, title: '' }
    }),
    focus: overrides.focus ?? (async (id: string) => {
      calls.focus.push(id)
    }),
    destroy: overrides.destroy ?? (async (id: string) => {
      calls.destroy.push(id)
    }),
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { browserPane: api },
  })
  return calls
}

describe('resolveCitationSourceTarget', () => {
  it('routes parsable http/https sources into the built-in browser', () => {
    expect(resolveCitationSourceTarget('https://example.com/a')).toEqual({
      kind: 'browser',
      url: 'https://example.com/a',
    })
    expect(resolveCitationSourceTarget('http://example.com/a').kind).toBe('browser')
  })

  it('rejects dangerous schemes with a reason and no fallback', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
      const target = resolveCitationSourceTarget(url)
      expect(target.kind).toBe('blocked')
    }
    expect(resolveCitationSourceTarget('')).toEqual({
      kind: 'blocked',
      reason: expect.stringContaining('empty'),
    })
    // file: targets normalize into the existing file preview, never the browser.
    expect(resolveCitationSourceTarget('file:///etc/passwd')).toEqual({
      kind: 'file',
      path: '/etc/passwd',
    })
  })

  it('keeps poloai deep links on their existing channel', () => {
    expect(resolveCitationSourceTarget('poloai://view/sessions/s1')).toEqual({
      kind: 'deeplink',
      url: 'poloai://view/sessions/s1',
    })
  })

  it('normalizes file: URLs into file-preview targets', () => {
    expect(resolveCitationSourceTarget('file:///tmp/report.pdf')).toEqual({
      kind: 'file',
      path: '/tmp/report.pdf',
    })
  })

  it('sends other registered external schemes to the existing external channel', () => {
    expect(resolveCitationSourceTarget('mailto:hi@example.com')).toEqual({
      kind: 'external',
      url: 'mailto:hi@example.com',
    })
  })
})

describe('canReuseForCitationSource', () => {
  const scope: CitationSourceScope = { sessionId: 'sess-a', workspaceId: 'ws-1' }

  it('reuses the citing session\'s own browser', () => {
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: 'sess-a' }), scope)).toBe(true)
  })

  it('reuses a workspace-level window of the citing workspace', () => {
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: null, workspaceId: 'ws-1' }), scope)).toBe(true)
  })

  it('never reuses another session\'s browser or another workspace\'s window', () => {
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: 'sess-b' }), scope)).toBe(false)
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: null, workspaceId: 'ws-2' }), scope)).toBe(false)
  })
})

describe('createCitationSourceOpener', () => {
  let scope: CitationSourceScope
  let onFile: ReturnType<typeof mock>
  let onExternal: ReturnType<typeof mock>
  let onBlocked: ReturnType<typeof mock>

  beforeEach(() => {
    scope = { sessionId: 'sess-a', workspaceId: 'ws-1' }
    onFile = mock((_p: string) => {})
    onExternal = mock((_u: string) => {})
    onBlocked = mock((_r: string) => {})
  })

  function makeOpener(paneOverrides?: Parameters<typeof installPane>[0]) {
    const calls = installPane(paneOverrides)
    const opener = createCitationSourceOpener({
      getSessionScope: () => scope,
      onOpenFile: onFile,
      onExternalUrl: onExternal,
      onBlocked,
    })
    return { calls, opener }
  }

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  })

  it('opens a https source in a NEW hidden session-bound instance: create → navigate → focus', async () => {
    const { calls, opener } = makeOpener()

    const outcome = await opener('https://example.com/source')

    expect(outcome).toEqual({ status: 'opened-in-browser', instanceId: 'created-1', reused: false })
    expect(calls.create).toEqual([{ show: false, bindToSessionId: 'sess-a' }])
    expect(calls.navigate).toEqual([['created-1', 'https://example.com/source']])
    expect(calls.focus).toEqual(['created-1'])
    expect(calls.destroy).toEqual([])
  })

  it('reuses the session\'s own browser instead of creating a second instance', async () => {
    const { calls, opener } = makeOpener({
      list: async () => [makeInstance({ id: 'owned-1', ownerSessionId: 'sess-a', workspaceId: 'ws-1' })],
    })

    const outcome = await opener('https://example.com/again')

    expect(outcome).toEqual({ status: 'opened-in-browser', instanceId: 'owned-1', reused: true })
    expect(calls.create).toEqual([])
    expect(calls.navigate).toEqual([['owned-1', 'https://example.com/again']])
    expect(calls.focus).toEqual(['owned-1'])
  })

  it('never reuses another session\'s browser — creates its own bound instance', async () => {
    const { calls, opener } = makeOpener({
      list: async () => [makeInstance({ id: 'foreign', ownerSessionId: 'sess-b' })],
    })

    const outcome = await opener('https://example.com/x')

    expect(outcome).toMatchObject({ status: 'opened-in-browser', instanceId: 'created-1' })
    expect(calls.navigate[0][0]).toBe('created-1')
    expect(calls.destroy).toEqual([])
  })

  it('rejects dangerous schemes without touching browserPane or the external channel', async () => {
    const { calls, opener } = makeOpener()

    const outcome = await opener('javascript:alert(1)')

    expect(outcome.status).toBe('blocked')
    expect(onBlocked).toHaveBeenCalledTimes(1)
    expect(calls.create).toEqual([])
    expect(calls.navigate).toEqual([])
    expect(onExternal).not.toHaveBeenCalled()
  })

  it('routes file targets to the existing file preview and poloai deep links to the external channel', async () => {
    const { calls, opener } = makeOpener()

    await opener('file:///tmp/report.pdf')
    await opener('poloai://view/sessions/s1')

    expect(onFile).toHaveBeenCalledWith('/tmp/report.pdf')
    expect(onExternal).toHaveBeenCalledWith('poloai://view/sessions/s1')
    expect(calls.create).toEqual([])
  })

  it('a stale scope detected while listing never creates an instance', async () => {
    const { calls, opener } = makeOpener()

    // The user switches to session B while the create is in flight.
    const pending = opener('https://example.com/late')
    scope = { sessionId: 'sess-b', workspaceId: 'ws-1' }
    const outcome = await pending

    expect(outcome).toEqual({ status: 'stale' })
    expect(calls.create).toEqual([])
    expect(calls.navigate).toEqual([])
    expect(calls.focus).toEqual([])
    expect(calls.destroy).toEqual([])
  })

  it('a stale scope after navigate recycles the undelivered instance and never focuses it', async () => {
    const { calls, opener } = makeOpener({
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        // The user switches to session B while the navigation is in flight.
        scope = { sessionId: 'sess-b', workspaceId: 'ws-1' }
        return { url, title: '' }
      },
    })

    const outcome = await opener('https://example.com/late')

    expect(outcome).toEqual({ status: 'stale' })
    expect(calls.focus).toEqual([])
    expect(calls.destroy).toEqual(['created-1'])
  })

  it('a stale scope BEFORE navigation recycles the instance without navigating it', async () => {
    const { calls, opener } = makeOpener({
      create: async (input) => {
        scope = { sessionId: 'sess-b', workspaceId: 'ws-1' }
        calls.create.push(input ?? {})
        return 'created-1'
      },
    })

    const outcome = await opener('https://example.com/late')

    expect(outcome).toEqual({ status: 'stale' })
    expect(calls.navigate).toEqual([])
    expect(calls.destroy).toEqual(['created-1'])
  })

  it('a failed navigation recycles ONLY this call\'s instance', async () => {
    const { calls, opener } = makeOpener({
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        throw new Error('ERR_NAVIGATION')
      },
    })

    const outcome = await opener('https://example.com/broken')

    expect(outcome).toEqual({ status: 'failed', reason: 'ERR_NAVIGATION' })
    expect(calls.destroy).toEqual(['created-1'])
    expect(calls.focus).toEqual([])
  })

  it('retries a fresh instance once when the startup empty-state race aborts the first navigate', async () => {
    let attempt = 0
    const onStartupRetry = mock((_e: string) => {})
    const calls = installPane({
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        attempt += 1
        // First navigate races Main's empty-state load and is aborted.
        if (attempt === 1) throw new Error("ERR_FAILED (-2) loading 'about:blank'")
        return { url, title: '' }
      },
    })
    const opener = createCitationSourceOpener({
      getSessionScope: () => scope,
      onOpenFile: onFile,
      onExternalUrl: onExternal,
      onBlocked,
      onStartupRetry,
    })

    const outcome = await opener('https://example.com/racy')

    expect(outcome).toEqual({ status: 'opened-in-browser', instanceId: 'created-1', reused: false })
    expect(calls.navigate).toEqual([
      ['created-1', 'https://example.com/racy'],
      ['created-1', 'https://example.com/racy'],
    ])
    expect(calls.destroy).toEqual([])
    expect(calls.focus).toEqual(['created-1'])
    expect(onStartupRetry).toHaveBeenCalledTimes(1)
  })

  it('recycles the fresh instance when the retry also fails', async () => {
    let attempt = 0
    const calls = installPane({
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        attempt += 1
        throw new Error(attempt === 1 ? 'ERR_ABORTED (-3)' : 'ERR_FAILED (-2)')
      },
    })
    const opener = createCitationSourceOpener({
      getSessionScope: () => scope,
      onOpenFile: onFile,
      onExternalUrl: onExternal,
      onBlocked,
    })

    const outcome = await opener('https://example.com/still-broken')

    expect(outcome).toEqual({ status: 'failed', reason: 'ERR_FAILED (-2)' })
    expect(calls.navigate.length).toBe(2)
    expect(calls.destroy).toEqual(['created-1'])
    expect(calls.focus).toEqual([])
  })

  it('a failed navigation on a REUSED browser never destroys the user\'s instance', async () => {
    const { calls, opener } = makeOpener({
      list: async () => [makeInstance({ id: 'owned-1', ownerSessionId: 'sess-a' })],
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        throw new Error('ERR_TIMEOUT')
      },
    })

    const outcome = await opener('https://example.com/broken')

    expect(outcome).toEqual({ status: 'failed', reason: 'ERR_TIMEOUT' })
    // The user's own browser survives; no second instance is created either.
    expect(calls.destroy).toEqual([])
    expect(calls.create).toEqual([])
  })

  it('fails cleanly when the browserPane API is unavailable', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
    const opener = createCitationSourceOpener({
      getSessionScope: () => scope,
      onOpenFile: onFile,
      onExternalUrl: onExternal,
    })

    const outcome = await opener('https://example.com/x')

    expect(outcome.status).toBe('failed')
  })
})
