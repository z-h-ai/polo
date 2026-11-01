import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof window === 'undefined') GlobalRegistrator.register()
mock.module('@polo-ai/ui', () => ({ classifyFile: (path: string) => path.endsWith('.zip') ? { canPreview: false, type: null } : { canPreview: true, type: 'text' } }))
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useLinkInterceptor } = await import('../useLinkInterceptor')
afterEach(cleanup)
function deferred() { let resolve!: (text: string) => void; const promise = new Promise<string>(r => { resolve = r }); return { promise, resolve } }
function setup() {
  let scope = 'a'
  const reads = new Map<string, ReturnType<typeof deferred>>()
  const external = mock(async () => {})
  const hook = renderHook(() => useLinkInterceptor({ scopeKey: () => scope, openFileExternal: external, openUrl: async () => {}, showInFolder: async () => {}, readFile: path => { const d = deferred(); reads.set(path, d); return d.promise }, readFileDataUrl: async () => '', readFileBinary: async () => new Uint8Array() }))
  return { hook, reads, external, scope: (s: string) => { scope = s } }
}
describe('unified file preview concurrency and lifecycle', () => {
  it('HTML opens a loading surface immediately; the later file wins over a slow read', async () => {
    const { hook, reads } = setup()
    act(() => { hook.result.current.handleOpenFile('slow.html') })
    expect(hook.result.current.previewState).toMatchObject({ type: 'html', content: null })
    expect(hook.result.current.previewVisible).toBe(true)
    act(() => { hook.result.current.handleOpenFile('new.txt') })
    await act(async () => { reads.get('new.txt')!.resolve('new') })
    await act(async () => { reads.get('slow.html')!.resolve('old') })
    expect(hook.result.current.previewState).toMatchObject({ filePath: 'new.txt', content: 'new' })
  })
  it('closed or previous-scope reads never resurrect a preview', async () => {
    const { hook, reads, scope } = setup()
    act(() => { hook.result.current.handleOpenFile('closed.html'); hook.result.current.closePreview() })
    await act(async () => { reads.get('closed.html')!.resolve('late') })
    expect(hook.result.current.previewState).toBeNull()
    act(() => { hook.result.current.handleOpenFile('other.html') })
    scope('b')
    await act(async () => { reads.get('other.html')!.resolve('private-a') })
    expect(hook.result.current.previewState).toMatchObject({ content: null, scopeKey: 'a' })
  })
  it('hide retains content, and opening an external-only file does not restore it', async () => {
    const { hook, reads, external } = setup()
    act(() => { hook.result.current.handleOpenFile('guide.html') })
    await act(async () => { reads.get('guide.html')!.resolve('<input>') })
    act(() => { hook.result.current.hidePreview(); hook.result.current.handleOpenFile('archive.zip') })
    expect(hook.result.current.previewVisible).toBe(false)
    expect(hook.result.current.previewState).toMatchObject({ content: '<input>' })
    expect(external).toHaveBeenCalledWith('archive.zip')
    act(() => hook.result.current.showPreview())
    expect(hook.result.current.previewVisible).toBe(true)
  })
})
