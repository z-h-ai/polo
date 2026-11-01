import { afterEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof window === 'undefined') GlobalRegistrator.register()
mock.module('@polo-ai/ui', () => ({ classifyFile: () => ({ canPreview: true, type: 'text' }) }))
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useLinkInterceptor } = await import('../useLinkInterceptor')
afterEach(cleanup)
it('seals content and pending reads to the selected session, including after switching back', async () => {
  let session = 'a'
  let resolve!: (s: string) => void
  const external = mock(async () => {})
  const hook = renderHook(() => useLinkInterceptor({ scopeKey: () => 'same-space', sessionId: () => session, readFile: () => new Promise<string>(r => { resolve = r }), openFileExternal: external, openUrl: async () => {}, showInFolder: external, readFileDataUrl: async () => '', readFileBinary: async () => new Uint8Array() } as any))
  act(() => { hook.result.current.handleOpenFile('/a/private.html') })
  expect(hook.result.current.previewState?.filePath).toBe('/a/private.html')
  session = 'b'; hook.rerender()
  expect(hook.result.current.previewState).toBeNull()
  expect(hook.result.current.previewVisible).toBe(false)
  await act(async () => { resolve('private A') })
  expect(hook.result.current.previewState).toBeNull()
  act(() => { hook.result.current.showPreview(); hook.result.current.openCurrentExternal() })
  expect(external).not.toHaveBeenCalled()
  session = 'a'; hook.rerender()
  expect(hook.result.current.previewState).toBeNull()
  act(() => { hook.result.current.handleOpenFile('/a/new.html') })
  await act(async () => { resolve('fresh') })
  expect(hook.result.current.previewState).toMatchObject({ content: 'fresh' })
})
