import { describe, expect, it, mock } from 'bun:test'
import type { ElectronAPI, BrowserInstanceInfo } from '../../../shared/types'
import { openBrowserLink } from '../open-browser-link'

const GUIDE = 'http://127.0.0.1:60283/fixtures/guide.html'
function setup(url = GUIDE) {
  let nextId = 1
  const makePage = (id: string, currentUrl: string) => ({ id, url: currentUrl, isVisible: false, hostMode: 'popup' as const, input: '网页保留', count: 3, scroll: 900 })
  let page: ReturnType<typeof makePage> | null = makePage('browser1', url)
  const create = mock(async () => {
    if (!page) page = makePage(`browser${++nextId}`, 'about:blank')
    return page.id
  })
  const focus = mock(async (_id: string) => { if (page) page.isVisible = true })
  const navigate = mock(async (_id: string, target: string) => {
    if (!page) throw new Error('No live page')
    page.url = target; page.input = ''; page.count = 0; page.scroll = 0
    return { url: target, title: 'Guide' }
  })
  const list = mock(async () => page ? [{ ...page }] as unknown as BrowserInstanceInfo[] : [])
  const api: Pick<ElectronAPI['browserPane'], 'create' | 'focus' | 'navigate' | 'list'> = { create, focus, navigate, list }
  return { api, page: () => page!, close: () => { page = null }, reload: () => { if (page) { page.input = ''; page.count = 0; page.scroll = 0 } } }
}
const options = { sessionId: 'session-a', isScopeCurrent: () => true }

describe('chat URL reopening preserves the live browser resource', () => {
  it('restores a hidden popup with its original input, counter, scroll and instance', async () => {
    const fixture = setup()
    const originalPage = fixture.page()
    await openBrowserLink(fixture.api, GUIDE, options)
    expect(fixture.api.create).toHaveBeenCalledWith({ show: false, bindToSessionId: 'session-a' })
    expect(fixture.api.focus).toHaveBeenCalledWith('browser1')
    expect(fixture.api.navigate).not.toHaveBeenCalled()
    expect(fixture.page()).toBe(originalPage)
    expect(fixture.page()).toMatchObject({ hostMode: 'popup', isVisible: true, input: '网页保留', count: 3, scroll: 900 })
  })
  it('clicking the currently visible same resource also preserves its page state', async () => {
    const fixture = setup()
    fixture.page().isVisible = true
    await openBrowserLink(fixture.api, GUIDE, options)
    expect(fixture.api.navigate).not.toHaveBeenCalled()
    expect(fixture.page()).toMatchObject({ input: '网页保留', count: 3, scroll: 900 })
  })
  it('compares canonical browser URLs so a homepage trailing slash does not reload it', async () => {
    const fixture = setup('https://example.test/')
    await openBrowserLink(fixture.api, 'https://example.test', options)
    expect(fixture.api.navigate).not.toHaveBeenCalled()
  })
  it('navigates a different query or hash as an explicit new link target', async () => {
    for (const suffix of ['?page=2', '#details']) {
      const fixture = setup()
      await openBrowserLink(fixture.api, GUIDE + suffix, options)
      expect(fixture.api.navigate).toHaveBeenCalledWith('browser1', GUIDE + suffix)
      expect(fixture.page()).toMatchObject({ url: GUIDE + suffix, input: '', count: 0, scroll: 0 })
    }
  })
  it('initially navigates a recreated instance after the previous page was explicitly closed', async () => {
    const fixture = setup()
    fixture.close()
    await openBrowserLink(fixture.api, GUIDE, options)
    expect(fixture.api.navigate).toHaveBeenCalledWith('browser2', GUIDE)
    expect(fixture.page().id).toBe('browser2')
  })
  it('leaves explicit same-URL navigation and refresh effective', async () => {
    const fixture = setup()
    const originalNavigate = fixture.api.navigate
    await openBrowserLink(fixture.api, GUIDE, options)
    await fixture.api.navigate('browser1', GUIDE)
    expect(fixture.api.navigate).toBe(originalNavigate)
    expect(fixture.api.navigate).toHaveBeenCalledTimes(1)
    expect(fixture.page()).toMatchObject({ input: '', count: 0, scroll: 0 })
    fixture.page().input = 'new draft'; fixture.page().count = 4; fixture.page().scroll = 700
    fixture.reload()
    expect(fixture.page()).toMatchObject({ input: '', count: 0, scroll: 0 })
  })
  it('does not navigate after the scope changes while reading the live browser list', async () => {
    const fixture = setup('https://example.test/other')
    let current = true
    fixture.api.list = mock(async () => { current = false; return [{ id: 'browser1', url: 'https://example.test/other' }] as BrowserInstanceInfo[] })
    await openBrowserLink(fixture.api, GUIDE, { sessionId: 'session-a', isScopeCurrent: () => current })
    expect(fixture.api.navigate).not.toHaveBeenCalled()
  })
})
