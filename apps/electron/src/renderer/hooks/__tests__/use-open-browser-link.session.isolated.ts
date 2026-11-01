import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof window === 'undefined') GlobalRegistrator.register()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useOpenBrowserLink } = await import('../use-open-browser-link')
import type { openBrowserLink } from '../../lib/open-browser-link'
afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function fixture() {
  let selected = 'a'
  const create = mock(async () => 'browser-a')
  const focus = mock(async () => { selected = 'a' })
  const list = mock(async () => [])
  const navigate = mock(async (_id: string, _url: string) => ({ url: _url, title: '' }))
  const api = { create, focus, list, navigate } as Parameters<typeof openBrowserLink>[0]
  const scope = { scopeKey: 'same-space', sessionId: 'a' }
  // This is the production callback used by App, including its scope capture;
  // callers never supply an artificial isScopeCurrent boolean.
  const hook = renderHook(({ owner }) => useOpenBrowserLink(api, owner), { initialProps: { owner: scope } })
  const select = (sessionId: string, scopeKey = 'same-space') => {
    selected = sessionId
    act(() => hook.rerender({ owner: { scopeKey, sessionId } }))
  }
  return { api, create, focus, list, navigate, hook, select, selected: () => selected }
}
const TARGET = 'https://example.test/guide'

describe('App browser link callback seals selection and request generation', () => {
  it('does not focus or navigate A after create resolves while B is selected', async () => {
    const f = fixture(); const pending = deferred<string>()
    f.api.create = mock(() => pending.promise)
    const opening = f.hook.result.current(TARGET)
    f.select('b'); pending.resolve('browser-a'); await opening
    expect(f.selected()).toBe('b')
    expect(f.focus).not.toHaveBeenCalled()
    expect(f.navigate).not.toHaveBeenCalled()
  })
  it('does not resurrect a pending A request after A to B to A', async () => {
    const f = fixture(); const pending = deferred<string>()
    f.api.create = mock(() => pending.promise)
    const opening = f.hook.result.current(TARGET)
    f.select('b'); f.select('a'); pending.resolve('browser-a'); await opening
    expect(f.focus).not.toHaveBeenCalled()
    expect(f.navigate).not.toHaveBeenCalled()
  })
  it('invalidates an A request when the browser list arrives after selecting B', async () => {
    const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.api.list>>>()
    f.api.list = mock(() => pending.promise)
    const opening = f.hook.result.current(TARGET)
    await Promise.resolve(); await Promise.resolve()
    f.select('b'); pending.resolve([]); await opening
    expect(f.selected()).toBe('b')
    expect(f.navigate).not.toHaveBeenCalled()
  })
  it('does not let an older delayed create override a newer URL in the same session', async () => {
    const f = fixture(); const pending = deferred<string>(); let calls = 0
    f.api.create = mock(() => ++calls === 1 ? pending.promise : Promise.resolve('browser-a'))
    const old = f.hook.result.current('https://example.test/old')
    await f.hook.result.current('https://example.test/new')
    pending.resolve('browser-a'); await old
    expect(f.navigate.mock.calls.map(call => call[1])).toEqual(['https://example.test/new'])
    expect(f.focus).toHaveBeenCalledTimes(1)
  })
  it('does not let an older delayed list override the later URL', async () => {
    const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.api.list>>>(); let calls = 0
    f.api.list = mock(() => ++calls === 1 ? pending.promise : Promise.resolve([]))
    const old = f.hook.result.current('https://example.test/old')
    await Promise.resolve(); await Promise.resolve()
    await f.hook.result.current('https://example.test/new')
    pending.resolve([]); await old
    expect(f.navigate.mock.calls.map(call => call[1])).toEqual(['https://example.test/new'])
  })
  it('rejects a stale App callback even before it starts creating a browser', async () => {
    const f = fixture(); const oldCallback = f.hook.result.current
    f.select('b'); await oldCallback(TARGET)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.focus).not.toHaveBeenCalled()
  })
  it('invalidates pending work on unmount', async () => {
    const f = fixture(); const pending = deferred<string>()
    f.api.create = mock(() => pending.promise)
    const opening = f.hook.result.current(TARGET)
    f.hook.unmount(); pending.resolve('browser-a'); await opening
    expect(f.focus).not.toHaveBeenCalled()
  })
  it('still allows a new explicit click after switching back to A', async () => {
    const f = fixture(); f.select('b'); f.select('a')
    await f.hook.result.current(TARGET)
    expect(f.focus).toHaveBeenCalledWith('browser-a')
    expect(f.navigate).toHaveBeenCalledWith('browser-a', TARGET)
  })
  it('keeps the existing ProductSpace boundary sealed', async () => {
    const f = fixture(); const pending = deferred<string>()
    f.api.create = mock(() => pending.promise)
    const opening = f.hook.result.current(TARGET)
    f.select('a', 'other-space'); pending.resolve('browser-a'); await opening
    expect(f.focus).not.toHaveBeenCalled()
  })
})
