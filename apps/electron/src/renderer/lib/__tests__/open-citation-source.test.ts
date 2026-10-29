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

  it('reuses the citing session\'s own browser inside the citing workspace', () => {
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: 'sess-a', workspaceId: 'ws-1' }), scope
    )).toBe(true)
  })

  it('reuses a workspace-level window of the citing workspace', () => {
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: null, workspaceId: 'ws-1' }), scope)).toBe(true)
  })

  it('never reuses another session\'s browser or another workspace\'s window', () => {
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: 'sess-b', workspaceId: 'ws-1' }), scope)).toBe(false)
    expect(canReuseForCitationSource(makeInstance({ ownerSessionId: null, workspaceId: 'ws-2' }), scope)).toBe(false)
  })
})

describe('canReuseForCitationSource workspace ownership (POO-172 R1 fix)', () => {
  // A session id is only unique WITHIN its workspace: the same id can legally
  // exist in two workspaces, so a name match alone must never adopt another
  // workspace's window.
  const scope: CitationSourceScope = { sessionId: 'same-session', workspaceId: 'ws-a' }

  it('never reuses a SAME-NAMED session bound in ANOTHER workspace', () => {
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: 'same-session', workspaceId: 'ws-b' }), scope
    )).toBe(false)
  })

  it('never reuses an instance of unknown workspace ownership', () => {
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: 'same-session', workspaceId: null }), scope
    )).toBe(false)
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: null, workspaceId: null }), scope
    )).toBe(false)
  })

  it('never reuses anything when the scope itself has no workspace context', () => {
    const homeless: CitationSourceScope = { sessionId: 'same-session', workspaceId: null }
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: 'same-session', workspaceId: 'ws-a' }), homeless
    )).toBe(false)
  })

  it('accepts the remote-mirror alias of the citing workspace (authoritative mapping)', () => {
    const remoteScope: CitationSourceScope = {
      sessionId: 'sess-a',
      workspaceId: 'ws-local',
      remoteWorkspaceId: 'ws-remote',
    }
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: 'sess-a', workspaceId: 'ws-remote' }), remoteScope
    )).toBe(true)
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: null, workspaceId: 'ws-remote' }), remoteScope
    )).toBe(true)
    // A third workspace sharing neither alias stays foreign.
    expect(canReuseForCitationSource(
      makeInstance({ ownerSessionId: 'sess-a', workspaceId: 'ws-c' }), remoteScope
    )).toBe(false)
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
      list: async () => [makeInstance({ id: 'foreign', ownerSessionId: 'sess-b', workspaceId: 'ws-1' })],
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
      list: async () => [makeInstance({ id: 'owned-1', ownerSessionId: 'sess-a', workspaceId: 'ws-1' })],
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

  it('reuses an instance stamped with the scope\'s REMOTE workspace alias', async () => {
    const { calls, opener } = makeOpener({
      list: async () => [makeInstance({ id: 'remote-1', ownerSessionId: 'sess-a', workspaceId: 'ws-remote' })],
    })

    scope = { sessionId: 'sess-a', workspaceId: 'ws-1', remoteWorkspaceId: 'ws-remote' }
    const outcome = await opener('https://example.com/remote')

    expect(outcome).toEqual({ status: 'opened-in-browser', instanceId: 'remote-1', reused: true })
    expect(calls.navigate).toEqual([['remote-1', 'https://example.com/remote']])
    expect(calls.create).toEqual([])
    expect(calls.destroy).toEqual([])
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

describe('createCitationSourceOpener get-or-create ownership (POO-172 R1 fix)', () => {
  // `api.create` is get-or-create (Main's createForSession): the resolved id
  // may be an instance that already existed. These cases lock the R1 fix —
  // a destroy may only ever touch an instance the call created AND never
  // delivered.
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

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
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

  it('never destroys an ADOPTED instance (create returned a pre-existing id)', async () => {
    // A global manual window with no workspace stamp is exactly what Main's
    // createForSession adopts; the create handler resolves with ITS id.
    const { calls, opener } = makeOpener({
      list: async () => [makeInstance({ id: 'manual-1', ownerSessionId: null, workspaceId: null })],
      create: async (input) => {
        calls.create.push(input ?? {})
        return 'manual-1'
      },
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        throw new Error('ERR_NAVIGATION')
      },
    })

    const outcome = await opener('https://example.com/broken')

    expect(outcome).toEqual({ status: 'failed', reason: 'ERR_NAVIGATION' })
    // The adopted (user-visible) manual window survives the failed navigation.
    expect(calls.destroy).toEqual([])
    expect(calls.focus).toEqual([])
  })

  it('does not destroy a fresh id that is VISIBLE by recycle time (delivered elsewhere)', async () => {
    let listings = 0
    const { calls, opener } = makeOpener({
      list: async () => {
        listings += 1
        // First list (reuse check) sees nothing; by recycle time another
        // window has already presented the instance to the user.
        return listings === 1
          ? []
          : [makeInstance({ id: 'created-1', ownerSessionId: 'sess-a', workspaceId: 'ws-1', isVisible: true })]
      },
      create: async (input) => {
        calls.create.push(input ?? {})
        return 'created-1'
      },
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        throw new Error('ERR_NAVIGATION')
      },
    })

    const outcome = await opener('https://example.com/raced')

    expect(outcome).toEqual({ status: 'failed', reason: 'ERR_NAVIGATION' })
    expect(calls.destroy).toEqual([])
  })

  it('serializes two concurrent opens on one scope: the shared get-or-create id is never destroyed', async () => {
    const { calls, opener } = makeOpener({
      create: async (input) => {
        calls.create.push(input ?? {})
        // get-or-create: BOTH calls resolve to the same bound instance.
        return 'shared-session-browser'
      },
    })

    const [first, second] = await Promise.all([
      opener('https://example.com/first'),
      opener('https://example.com/second'),
    ])

    expect(first).toMatchObject({ status: 'opened-in-browser', instanceId: 'shared-session-browser' })
    expect(second).toMatchObject({ status: 'opened-in-browser', instanceId: 'shared-session-browser' })
    expect(calls.destroy).toEqual([])
    expect(calls.focus).toEqual(['shared-session-browser', 'shared-session-browser'])
  })

  it('a failing open can no longer recycle an id another open has already delivered', async () => {
    // Reviewer probe scenario (CITE-CREATE-NOT-EXCLUSIVE): two clicks resolve
    // to the SAME id; the first open keeps failing while the second delivers.
    const timeline: string[] = []
    let navigateAttempt = 0
    const { calls, opener } = makeOpener({
      create: async (input) => {
        calls.create.push(input ?? {})
        timeline.push('create')
        return 'shared-session-browser'
      },
      navigate: async (id, url) => {
        calls.navigate.push([id, url])
        navigateAttempt += 1
        timeline.push(`navigate:${navigateAttempt}`)
        if (navigateAttempt <= 2) throw new Error('ERR_ABORTED (-3)')
        return { url, title: '' }
      },
      focus: async (id) => {
        calls.focus.push(id)
        timeline.push(`focus:${id}`)
      },
      destroy: async (id) => {
        calls.destroy.push(id)
        timeline.push(`destroy:${id}`)
      },
    })

    const [first, second] = await Promise.all([
      opener('https://example.com/one'),
      opener('https://example.com/two'),
    ])

    expect(first).toMatchObject({ status: 'failed' })
    expect(second).toMatchObject({ status: 'opened-in-browser', instanceId: 'shared-session-browser' })
    // Whatever gets destroyed must be destroyed BEFORE the surviving open
    // delivers (focus) — never after.
    const destroyAt = calls.destroy.indexOf('shared-session-browser')
    expect(destroyAt).toBeGreaterThanOrEqual(0)
    expect(timeline.indexOf(`destroy:shared-session-browser`))
      .toBeLessThan(timeline.indexOf(`focus:shared-session-browser`))
  })

  it('never reuses a same-named session bound in another workspace — creates its own', async () => {
    const { calls, opener } = makeOpener({
      list: async () => [
        makeInstance({ id: 'ws-b-window', ownerSessionId: 'sess-a', workspaceId: 'ws-b' }),
      ],
    })

    const outcome = await opener('https://example.com/cross')

    expect(outcome).toEqual({ status: 'opened-in-browser', instanceId: 'created-1', reused: false })
    expect(calls.navigate[0][0]).toBe('created-1')
    // The foreign workspace's window is untouched.
    expect(calls.destroy).toEqual([])
  })
})
