/**
 * UiCardRegistry (POO-103): two-dimensional ownership for canvas cards.
 * Pure in-memory module — no electron import, safe to exercise directly.
 */

import { describe, expect, it } from 'bun:test'
import {
  UiCardRegistry,
  extractCapabilitiesFromDocument,
  extractPoloBridgeCapabilities,
} from '../ui-card-registry'

const ATTACH = {
  guestWebContentsId: 101,
  hostWebContentsId: 1,
  sessionId: 'session-a',
  partition: 'genui-app-session-a',
  capabilities: ['ui-event'],
}

function attach(registry: UiCardRegistry, overrides: Partial<typeof ATTACH> = {}): void {
  registry.noteGuestAttached({ ...ATTACH, ...overrides })
}

function register(registry: UiCardRegistry, overrides: Partial<Parameters<UiCardRegistry['registerCard']>[0]> = {}) {
  return registry.registerCard({
    sessionId: 'session-a',
    cardId: 'card-a',
    guestWebContentsId: 101,
    hostWebContentsId: 1,
    ...overrides,
  })
}

describe('UiCardRegistry.registerCard', () => {
  it('registers a card whose attach record matches (capabilities issued from the attach)', () => {
    const registry = new UiCardRegistry()
    attach(registry)
    const verdict = register(registry)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.entry.capabilities).toEqual(['ui-event'])
      expect(verdict.entry.webContentsId).toBe(101)
    }
    expect(registry.getCard('session-a', 'card-a')?.capabilities).toEqual(['ui-event'])
  })

  it('rejects a guest Main never observed attaching', () => {
    const registry = new UiCardRegistry()
    const verdict = register(registry, { guestWebContentsId: 999 })
    expect(verdict).toEqual({ ok: false, reason: 'guest_unknown' })
  })

  it('rejects a card whose claimed session disagrees with the attach record', () => {
    const registry = new UiCardRegistry()
    attach(registry, { sessionId: 'session-b', partition: 'genui-app-session-b' })
    expect(register(registry, { sessionId: 'session-a' })).toEqual({ ok: false, reason: 'guest_session_mismatch' })
  })

  it('rejects a registration from a different host window than the attach', () => {
    const registry = new UiCardRegistry()
    attach(registry)
    expect(register(registry, { hostWebContentsId: 2 })).toEqual({ ok: false, reason: 'guest_host_mismatch' })
  })

  it('rejects malformed session and card ids', () => {
    const registry = new UiCardRegistry()
    attach(registry)
    expect(register(registry, { sessionId: '../escape' }).ok).toBe(false)
    expect(register(registry, { cardId: '-leading-dash' })).toEqual({ ok: false, reason: 'invalid_card_id' })
    expect(register(registry, { cardId: 'has space' })).toEqual({ ok: false, reason: 'invalid_card_id' })
  })

  it('re-registration re-signs capabilities from the current attach record', () => {
    const registry = new UiCardRegistry()
    attach(registry, { capabilities: [] })
    expect(register(registry, { cardId: 'card-a' })).toMatchObject({ ok: true })
    expect(registry.getCard('session-a', 'card-a')?.capabilities).toEqual([])

    // Same guest, new document (new attach with the declaration) → new grant.
    attach(registry, { capabilities: ['ui-event'] })
    expect(register(registry, { cardId: 'card-a' })).toMatchObject({ ok: true })
    expect(registry.getCard('session-a', 'card-a')?.capabilities).toEqual(['ui-event'])
  })
})

describe('UiCardRegistry lifecycle', () => {
  it('drops every card bound to a detached guest', () => {
    const registry = new UiCardRegistry()
    attach(registry)
    register(registry, { cardId: 'card-a' })
    // A second session whose card renders in a different guest stays intact.
    attach(registry, { guestWebContentsId: 202, sessionId: 'session-b', partition: 'genui-app-session-b' })
    register(registry, { cardId: 'card-b', sessionId: 'session-b', guestWebContentsId: 202 })

    const removed = registry.noteGuestDetached(101)
    expect(removed).toEqual([{ sessionId: 'session-a', cardId: 'card-a' }])
    expect(registry.getCard('session-a', 'card-a')).toBeUndefined()
    expect(registry.getCard('session-b', 'card-b')).toBeDefined()
    // Re-detach is a no-op.
    expect(registry.noteGuestDetached(101)).toEqual([])
  })

  it('clearSession removes only that session’s cards', () => {
    const registry = new UiCardRegistry()
    attach(registry)
    attach(registry, { guestWebContentsId: 202, sessionId: 'session-b', partition: 'genui-app-session-b' })
    register(registry, { cardId: 'card-a' })
    register(registry, { cardId: 'card-b', sessionId: 'session-b', guestWebContentsId: 202 })

    expect(registry.clearSession('session-a')).toBe(1)
    expect(registry.hasCardsForSession('session-a')).toBe(false)
    expect(registry.getCard('session-b', 'card-b')).toBeDefined()
    expect(registry.clearSession('session-a')).toBe(0)
  })

  it('step-2 discrimination: session with other cards → card_not_registered shape, without cards → session_not_found shape', () => {
    const registry = new UiCardRegistry()
    attach(registry)
    register(registry, { cardId: 'card-a' })
    // Session known but card unknown → the validator distinguishes via hasCardsForSession.
    expect(registry.hasCardsForSession('session-a')).toBe(true)
    expect(registry.getCard('session-a', 'card-z')).toBeUndefined()
    expect(registry.hasCardsForSession('session-empty')).toBe(false)
  })
})

describe('capability extraction', () => {
  it('finds the declaration whatever the attribute order or quoting', () => {
    expect(extractCapabilitiesFromDocument('<html><head><meta name="polo-bridge-capabilities" content="ui-event"></head></html>'))
      .toEqual(['ui-event'])
    expect(extractCapabilitiesFromDocument("<html><head><meta content='ui-event' name='polo-bridge-capabilities'></head></html>"))
      .toEqual(['ui-event'])
    expect(extractCapabilitiesFromDocument('<html><head><meta name=polo-bridge-capabilities content=ui-event></head></html>'))
      .toEqual(['ui-event'])
  })

  it('drops unknown tokens and dedupes', () => {
    expect(extractCapabilitiesFromDocument('<meta name="polo-bridge-capabilities" content="ui-event, run-tool, ui-event">'))
      .toEqual(['ui-event'])
  })

  it('yields nothing without the meta or with an empty content', () => {
    expect(extractCapabilitiesFromDocument('<html><head><title>plain</title></head></html>')).toEqual([])
    expect(extractCapabilitiesFromDocument('<meta name="polo-bridge-capabilities" content="">')).toEqual([])
    expect(extractCapabilitiesFromDocument('<meta name="something-else" content="ui-event">')).toEqual([])
  })

  it('reads a data: URL document (percent and base64)', () => {
    const html = '<html><head><meta name="polo-bridge-capabilities" content="ui-event"></head><body>hi</body></html>'
    expect(extractPoloBridgeCapabilities(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`))
      .toEqual(['ui-event'])
    expect(extractPoloBridgeCapabilities(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`))
      .toEqual(['ui-event'])
  })

  it('fails closed on unreadable or foreign sources', () => {
    expect(extractPoloBridgeCapabilities('file:///definitely/not/there/index.html')).toEqual([])
    expect(extractPoloBridgeCapabilities('https://example.com/app.html')).toEqual([])
    expect(extractPoloBridgeCapabilities('not a url')).toEqual([])
    expect(extractPoloBridgeCapabilities('data:text/html,%zz-broken-encoding')).toEqual([])
  })
})
