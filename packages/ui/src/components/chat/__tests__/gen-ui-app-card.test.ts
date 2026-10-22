import { describe, it, expect } from 'bun:test'
import { pathToFileURL } from 'node:url'
import {
  GENUI_APP_PUBLISH_EVENT,
  buildGenUiAppSrc,
  dispatchGenUiAppPublish,
  dispatchGenUiAppPublishResult,
  getGenUiAppPartition,
  mergeGenUiAppCalls,
  onGenUiAppPublishResult,
  parseGenUiAppInput,
  parseGenUiAppResult,
  pathToFileUrl,
} from '../GenUiAppCard'

describe('getGenUiAppPartition', () => {
  it('is namespaced per session and NEVER persist:-prefixed', () => {
    expect(getGenUiAppPartition('sess-123')).toBe('genui-app-sess-123')
    expect(getGenUiAppPartition('sess-123').startsWith('persist:')).toBe(false)
  })

  it('collapses unusable session ids to a safe shared bucket', () => {
    expect(getGenUiAppPartition(null)).toBe('genui-app-unknown')
    expect(getGenUiAppPartition(undefined)).toBe('genui-app-unknown')
    expect(getGenUiAppPartition('')).toBe('genui-app-unknown')
    // A persist:-prefixed or traversal-looking id must not reach the partition name
    expect(getGenUiAppPartition('persist:tab-app-x')).toBe('genui-app-unknown')
    expect(getGenUiAppPartition('../other-session')).toBe('genui-app-unknown')
  })
})

describe('parseGenUiAppResult', () => {
  it('parses the generate_app marker line', () => {
    const result = parseGenUiAppResult(
      'Generative UI app "Demo" created (v1).\n'
      + 'App id: app-abc\n'
      + '[genui-app id="app-abc" version="2" path="/tmp/data/genui-apps/app-abc/index.html"]',
    )
    expect(result).toEqual({
      appId: 'app-abc',
      version: 2,
      indexPath: '/tmp/data/genui-apps/app-abc/index.html',
    })
  })

  it('returns null for results without a marker or with a broken one', () => {
    expect(parseGenUiAppResult('')).toBeNull()
    expect(parseGenUiAppResult(null)).toBeNull()
    expect(parseGenUiAppResult('no marker here')).toBeNull()
    expect(parseGenUiAppResult('[genui-app id="a" version="x" path="/p"]')).toBeNull()
  })
})

describe('parseGenUiAppInput', () => {
  it('accepts a valid tool input and rejects unusable payloads', () => {
    expect(parseGenUiAppInput({ title: 'Demo', html: '<p>hi</p>' })).toEqual({ title: 'Demo', html: '<p>hi</p>' })
    expect(parseGenUiAppInput(null)).toBeNull()
    expect(parseGenUiAppInput({ html: '<p>' })).toBeNull()
    expect(parseGenUiAppInput({ title: 'Demo' })).toBeNull()
    expect(parseGenUiAppInput({ title: '', html: '<p>' })).toBeNull()
  })
})

describe('pathToFileUrl', () => {
  it('matches node:url pathToFileURL for POSIX paths (spaces, hashes, unicode, percent)', () => {
    for (const p of [
      '/tmp/genui-apps/app-1/index.html',
      '/tmp/my app dir/app-1/index.html',
      '/tmp/we#rd?name/index.html',
      '/tmp/100%valid/index.html',
      '/tmp/ünïcøde/app/index.html',
    ]) {
      expect(pathToFileUrl(p)).toBe(pathToFileURL(p).href)
    }
  })

  it('gives Windows drive paths the well-formed third slash and encodes specials', () => {
    expect(pathToFileUrl('C:\\data\\genui-apps\\app-1\\index.html')).toBe(
      'file:///C:/data/genui-apps/app-1/index.html',
    )
    expect(pathToFileUrl('C:/my dir/app#1/index.html')).toBe(
      'file:///C:/my%20dir/app%231/index.html',
    )
  })
})

describe('buildGenUiAppSrc', () => {
  it('prefers the written bundle file and encodes path segments', () => {
    expect(buildGenUiAppSrc('/tmp/my app dir/app-1/index.html', '')).toBe(
      'file:///tmp/my%20app%20dir/app-1/index.html',
    )
    expect(buildGenUiAppSrc('C:\\data\\genui-apps\\app-1\\index.html', '')).toBe(
      'file:///C:/data/genui-apps/app-1/index.html',
    )
    // URL-significant characters can never split the src.
    expect(buildGenUiAppSrc('/tmp/app#1/index.html', '')).toBe('file:///tmp/app%231/index.html')
    expect(buildGenUiAppSrc('/tmp/app?1/index.html', '')).toBe('file:///tmp/app%3F1/index.html')
  })

  it('falls back to an inline data URL without a path', () => {
    const src = buildGenUiAppSrc(undefined, '<p>hi</p>')
    expect(src.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(src).toContain(encodeURIComponent('<p>hi</p>'))
    expect(src.startsWith('persist:')).toBe(false)
  })
})

describe('mergeGenUiAppCalls', () => {
  it('merges successive calls of one app id in place, first-seen order wins', () => {
    const merged = mergeGenUiAppCalls([
      { appId: 'a', title: 'A v1', html: 'one' },
      { appId: 'b', title: 'B', html: 'two' },
      { appId: 'a', title: 'A v2', html: 'three', version: 2 },
    ])
    expect(merged.length).toBe(2)
    expect(merged[0]!.appId).toBe('a')
    expect(merged[0]!.html).toBe('three')
    expect(merged[0]!.version).toBe(2)
    expect(merged[1]!.appId).toBe('b')
  })
})

describe('publish bridge events (POO-104)', () => {
  const globalScope = globalThis as { window?: EventTarget }
  const originalWindow = globalScope.window
  let fakeWindow: EventTarget

  function useFakeWindow(): void {
    fakeWindow = new EventTarget()
    globalScope.window = fakeWindow
  }

  function restoreWindow(): void {
    globalScope.window = originalWindow
  }

  it('dispatchGenUiAppPublish carries the request on the publish event', () => {
    useFakeWindow()
    try {
      const request = { requestId: 'r1', sessionId: 'sess-1', appId: 'app-1', title: 'Demo' }
      let received: unknown = null
      fakeWindow.addEventListener(GENUI_APP_PUBLISH_EVENT, (event) => {
        received = (event as CustomEvent).detail
      })
      dispatchGenUiAppPublish(request)
      expect(received).toEqual(request)
    } finally {
      restoreWindow()
    }
  })

  it('onGenUiAppPublishResult filters by requestId and unsubscribes', () => {
    useFakeWindow()
    try {
      const seen: boolean[] = []
      const unsubscribe = onGenUiAppPublishResult('r2', (result) => {
        seen.push(result.ok)
      })
      // Another request's result must not leak into this subscription.
      dispatchGenUiAppPublishResult({ requestId: 'other', ok: false })
      dispatchGenUiAppPublishResult({ requestId: 'r2', ok: true })
      unsubscribe()
      dispatchGenUiAppPublishResult({ requestId: 'r2', ok: false })
      expect(seen).toEqual([true])
    } finally {
      restoreWindow()
    }
  })
})
