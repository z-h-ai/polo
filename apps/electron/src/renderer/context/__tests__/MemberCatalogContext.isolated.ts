import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { AppCatalogInstance } from '../MemberCatalogContext'

GlobalRegistrator.register()

const { cleanup, render } = await import('@testing-library/react')
const { MemberCatalogProvider, useMemberCatalog } = await import('../MemberCatalogContext')

beforeEach(() => {
  // The provider's own `useAppCatalog` instance reads the host platform on
  // mount; without an active ProductSpace no catalog sync RPC is issued.
  ;(globalThis as Record<string, unknown>).window = window
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localApps: {
        getHostInfo: () => Promise.resolve({ platform: 'darwin', arch: 'arm64' }),
      },
    },
  })
})

afterEach(() => {
  cleanup()
})

type ProbeRecorder = { current: AppCatalogInstance | null }

function ProbeChild({ recorder }: { recorder: ProbeRecorder }) {
  recorder.current = useMemberCatalog()
  return null
}

function renderConsumers(
  count: number,
  recorders: ProbeRecorder[],
  providerProps: { catalog?: AppCatalogInstance } = {},
) {
  return render(createElement(MemberCatalogProvider, {
    ...providerProps,
    children: Array.from({ length: count }, (_, index) => createElement(ProbeChild, {
      key: index,
      recorder: recorders[index]!,
    })),
  }))
}

describe('MemberCatalogProvider (POO-70 H1 single instance holder)', () => {
  it('gives every consumer the SAME instance and method identities', () => {
    const first: ProbeRecorder = { current: null }
    const second: ProbeRecorder = { current: null }
    renderConsumers(2, [first, second])
    expect(first.current).not.toBeNull()
    expect(second.current).not.toBeNull()
    // One live instance: identical object and identical refresh/launch methods.
    expect(first.current).toBe(second.current)
    expect(first.current!.sync).toBe(second.current!.sync)
    expect(first.current!.resolveLaunch).toBe(second.current!.resolveLaunch)
  })

  it('serves an injected pre-existing instance without creating a second one', () => {
    // H2 extraction transition: HomePage injects its current instance.
    const injected = { marker: 'injected-homepage-instance' } as unknown as AppCatalogInstance
    const first: ProbeRecorder = { current: null }
    const second: ProbeRecorder = { current: null }
    renderConsumers(2, [first, second], { catalog: injected })
    expect(first.current).toBe(injected)
    expect(second.current).toBe(injected)
  })

  it('throws a loud error when used outside a provider', () => {
    const recorder: ProbeRecorder = { current: null }
    let renderError: Error | null = null
    try {
      render(createElement(ProbeChild, { recorder }))
    } catch (error) {
      renderError = error as Error
    }
    expect(renderError).toBeInstanceOf(Error)
    expect(renderError!.message).toContain('useMemberCatalog must be used within MemberCatalogProvider')
    expect(recorder.current).toBeNull()
  })
})
