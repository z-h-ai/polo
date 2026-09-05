import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useLayoutEffect } from 'react'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { ProductSpaceAppLaunchRequest } from '@/lib/product-space-app-launch-handoff'
import {
  useProductSpaceAppLaunchHandoff,
  type ProductSpaceContextValue,
} from '../ProductSpaceContext'

GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ProductSpaceProvider, useOptionalProductSpaceContext } = await import('../ProductSpaceContext')

const launch: ResolveLaunchResponse = {
  contractVersion: 1,
  productSpaceId: 'space-a' as never,
  catalogEntryId: 'entry-a' as never,
  resolvedAt: '2099-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:10:00.000Z',
  subject: {
    kind: 'artifact_instance',
    artifactType: 'app',
    artifactInstanceId: 'artifact-a' as never,
    versionId: 'version-a' as never,
    version: '1.0.0',
  },
  payer: { kind: 'account' },
  delivery: {
    kind: 'web_url',
    url: 'https://app.example.test',
    launchToken: 'fresh-launch-token',
  },
}

const launchB: ResolveLaunchResponse = {
  contractVersion: 1,
  productSpaceId: 'space-b' as never,
  catalogEntryId: 'entry-b' as never,
  resolvedAt: '2099-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:10:00.000Z',
  subject: {
    kind: 'artifact_instance',
    artifactType: 'app',
    artifactInstanceId: 'artifact-b' as never,
    versionId: 'version-b' as never,
    version: '1.0.0',
  },
  payer: { kind: 'account' },
  delivery: {
    kind: 'web_url',
    url: 'https://app-b.example.test',
    launchToken: 'b-launch-token',
  },
}

const expectedContext = {
  accountId: 'account-a',
  productSpaceId: 'space-a',
  catalogEntryId: 'entry-a',
  artifactInstanceId: 'artifact-a',
  versionId: 'version-a',
  version: '1.0.0',
  deliveryKind: 'web_url' as const,
  resolvedAt: launch.resolvedAt,
  expiresAt: launch.expiresAt,
}

const expectedContextB = {
  ...expectedContext,
  productSpaceId: 'space-b',
  catalogEntryId: 'entry-b',
  artifactInstanceId: 'artifact-b',
  versionId: 'version-b',
  resolvedAt: launchB.resolvedAt,
  expiresAt: launchB.expiresAt,
}

/**
 * Probe children exercise the REAL hook from inside a real mounted provider:
 * publish/take validate against the committed context read at call time.
 * `probeActions` keeps the closures created under the mounted provider so
 * stale-closure behavior after unmount can also be asserted.
 */
let probePublishError: Error | null = null
let probePublishedRequest: ProductSpaceAppLaunchRequest | null = null
let probeActions: {
  publish(fixture?: ResolveLaunchResponse): void
  take(handoffId: string, expected?: typeof expectedContext): unknown
} | null = null

function ProbeChild({ onReady }: { onReady?: () => void }) {
  const handoff = useProductSpaceAppLaunchHandoff()
  probeActions = {
    publish(fixture: ResolveLaunchResponse = launch) {
      probePublishError = null
      try {
        probePublishedRequest = handoff.publish('account-a', fixture)
      } catch (error) {
        probePublishError = error as Error
      }
    },
    take(handoffId: string, expected: typeof expectedContext = expectedContext) {
      return handoff.take(handoffId, expected)
    },
  }
  onReady?.()
  return createElement('button', {
    type: 'button',
    'data-testid': 'handoff-probe-publish',
    onClick: () => probeActions?.publish(),
  })
}

function providerValue(overrides: Partial<ProductSpaceContextValue> = {}): ProductSpaceContextValue {
  // Test-only summary literal: branded id types are erased at runtime.
  return {
    accountId: 'account-a',
    activeProductSpaceId: 'space-a',
    activeProductSpace: { id: 'space-a', kind: 'personal', name: 'Space A' },
    productSpaces: [],
    allProductSpaces: [],
    personalProductSpaceId: 'space-a',
    productSpaceContextKey: 'account-a|space-a',
    contextVersion: 0,
    pendingSwitch: null,
    onSelectProductSpace: () => {},
    onRefreshProductSpaces: () => {},
    onConfirmStopAndSwitch: () => {},
    onRetryFailedStops: () => {},
    onRetryTargetLoad: () => {},
    onCancelSwitch: () => {},
    onDismissTargetAccessLost: () => {},
    onStopSwitchExecution: () => {},
    ...overrides,
  } as unknown as ProductSpaceContextValue
}

type ReactElementType = Parameters<typeof createElement>[0]

function renderProvider(value: ProductSpaceContextValue, probe?: ReactElementType) {
  return render(createElement(ProductSpaceProvider, {
    value,
    children: createElement(probe ?? ProbeChild),
  }))
}

beforeEach(() => {
  probePublishError = null
  probePublishedRequest = null
  probeActions = null
})

afterEach(() => {
  cleanup()
})

describe('ProductSpaceProvider launch handoff lifecycle', () => {
  it('seals and takes a handoff while the provider is mounted', () => {
    renderProvider(providerValue())
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    expect(probePublishError).toBeNull()
    const request = probePublishedRequest!
    expect(probeActions!.take(request.handoffId)).not.toBeNull()
  })

  it('cannot reach old handles after unmount and a fresh provider mount', () => {
    const first = renderProvider(providerValue())
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    const sealed = probePublishedRequest!
    first.unmount()

    // A NEW provider mount owns a fresh store: the old handle is unreachable
    // through the live tree, and old-closure probes on the dead tree can no
    // longer mount or publish through any provider.
    const second = renderProvider(providerValue())
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    const resealed = probePublishedRequest!
    expect(sealed.handoffId).not.toBe(resealed.handoffId)
    expect(probeActions!.take(sealed.handoffId)).toBeNull()
    expect(probeActions!.take(resealed.handoffId)).not.toBeNull()
    second.unmount()
  })

  it('fails closed across a space switch and re-arms after re-authentication', () => {
    const view = renderProvider(providerValue())
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    const sealedBeforeSwitch = probePublishedRequest!

    // Same mounted provider switches the committed space: the context read
    // now returns B, so the stale A handle can never be taken…
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue({ activeProductSpaceId: 'space-b', productSpaceContextKey: 'account-a|space-b' }),
      children: createElement(ProbeChild),
    }))
    expect(probeActions!.take(sealedBeforeSwitch.handoffId)).toBeNull()

    // …and publishing for the OLD space fails closed under B.
    probeActions!.publish()
    expect((probePublishError as Error | null)?.message).toContain('another ProductSpace context')

    // Re-authentication back into the original space re-arms publishing.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: createElement(ProbeChild),
    }))
    probeActions!.publish()
    expect(probePublishError).toBeNull()
    const resealed = probePublishedRequest!
    expect(probeActions!.take(sealedBeforeSwitch.handoffId)).toBeNull()
    expect(probeActions!.take(resealed.handoffId)).not.toBeNull()
    view.unmount()
  })

  it('keeps the committed A space working when a speculative B tree is rendered elsewhere', () => {
    // Root 1: the committed A context with a sealed handle.
    const committedRoot = renderProvider(providerValue())
    const aProbe = probeActions!
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    const sealed = probePublishedRequest!

    // Root 2: a speculative/duplicate B render — with a render-phase module
    // mutation this would have flipped the global live context and broken A.
    const speculativeRoot = renderProvider(providerValue({
      activeProductSpaceId: 'space-b',
      productSpaceContextKey: 'account-a|space-b',
    }))
    const bProbe = probeActions!
    bProbe.publish(launchB)
    expect(probePublishError).toBeNull()
    const bRequest = probePublishedRequest!
    expect(bRequest).not.toBeNull()

    // The committed A tree still publishes and takes exactly as before.
    aProbe.publish()
    expect(probePublishError).toBeNull()
    expect(aProbe.take(sealed.handoffId)).not.toBeNull()
    // Each tree's own handle is bound to its own context and store.
    expect(bProbe.take(bRequest.handoffId, expectedContextB)).not.toBeNull()
    expect(bProbe.take(sealed.handoffId, expectedContext)).toBeNull()

    speculativeRoot.unmount()
    committedRoot.unmount()
  })

  it('does not let a NEW context subtree layout consumer take the previous token', () => {
    let sealedForLayoutTakeover: ProductSpaceAppLaunchRequest | null = null
    let takenDuringNewContextLayout: unknown = 'not-run'

    function LayoutTakeoverChild() {
      const handoff = useProductSpaceAppLaunchHandoff()
      const ps = useOptionalProductSpaceContext()
      useLayoutEffect(() => {
        // Runs during the B commit, BEFORE any provider passive effect could
        // have invalidated anything: only the committed-context read stands
        // between the stale token and the consumer.
        if (ps?.activeProductSpaceId === 'space-b') {
          takenDuringNewContextLayout = handoff.take(
            sealedForLayoutTakeover!.handoffId,
            expectedContext,
          )
        }
      }, [])
      return null
    }

    const view = render(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: createElement(ProbeChild),
    }))
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    sealedForLayoutTakeover = probePublishedRequest
    expect(sealedForLayoutTakeover).not.toBeNull()

    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue({ activeProductSpaceId: 'space-b', productSpaceContextKey: 'account-a|space-b' }),
      children: createElement(LayoutTakeoverChild),
    }))

    expect(takenDuringNewContextLayout).toBeNull()
    view.unmount()
  })
})
