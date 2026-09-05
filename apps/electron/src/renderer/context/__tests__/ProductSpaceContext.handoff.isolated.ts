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
  publish(fixture?: ResolveLaunchResponse, accountId?: string): void
  take(handoffId: string, expected?: typeof expectedContext): unknown
} | null = null

function ProbeChild({ onReady }: { onReady?: () => void }) {
  const handoff = useProductSpaceAppLaunchHandoff()
  probeActions = {
    publish(fixture: ResolveLaunchResponse = launch, accountId = 'account-a') {
      probePublishError = null
      try {
        probePublishedRequest = handoff.publish(accountId, fixture)
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

  it('does not revive the pre-transition handle when the context returns A→B→A without probing in B', () => {
    const view = renderProvider(providerValue())
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    const sealedUnderA = probePublishedRequest!

    // A→B then back to A — the old handle is NEVER touched in B.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue({ activeProductSpaceId: 'space-b', productSpaceContextKey: 'account-a|space-b' }),
      children: createElement(ProbeChild),
    }))
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: createElement(ProbeChild),
    }))

    // The committed context is A again and publishing works — but the
    // pre-transition handle stays permanently dead (generation fence).
    probeActions!.publish()
    expect(probePublishError).toBeNull()
    const fresh = probePublishedRequest!
    expect(probeActions!.take(sealedUnderA.handoffId)).toBeNull()
    expect(probeActions!.take(fresh.handoffId)).not.toBeNull()
    view.unmount()
  })

  it('does not collide delimiter-shaped account/space tuples when switching', () => {
    // A=(accountId 'a|b', space 'c') vs B=(accountId 'a', space 'b|c'):
    // a delimiter-concatenated generation key would map both to 'a|b|c' and
    // let the A→B→A round-trip revive the old handle. The committed key is
    // the shared versioned tuple, and liveness compares structured fields.
    const providerA = providerValue({
      accountId: 'a|b' as never,
      activeProductSpaceId: 'c' as never,
      productSpaceContextKey: 'tuple-a',
    })
    const providerB = providerValue({
      accountId: 'a' as never,
      activeProductSpaceId: 'b|c' as never,
      productSpaceContextKey: 'tuple-b',
    })
    // launchB already carries productSpaceId 'space-b'; point it at B's
    // collision space instead.
    const launchCollision = {
      ...launch,
      productSpaceId: 'b|c' as never,
      catalogEntryId: 'entry-b' as never,
      subject: {
        kind: 'artifact_instance' as const,
        artifactType: 'app' as const,
        artifactInstanceId: 'artifact-b' as never,
        versionId: 'version-b' as never,
        version: '1.0.0',
      },
    }
    const expectedCollisionContext = {
      ...expectedContext,
      accountId: 'a',
      productSpaceId: 'b|c',
      catalogEntryId: 'entry-b',
      artifactInstanceId: 'artifact-b',
      versionId: 'version-b',
    }

    const view = render(createElement(ProductSpaceProvider, {
      value: providerA,
      children: createElement(ProbeChild),
    }))
    // Publish under A=(a|b, c).
    probeActions!.publish({
      ...launch,
      productSpaceId: 'c' as never,
    }, 'a|b')
    if (probePublishError) {
      throw new Error(`A publish failed: ${probePublishError.message}`)
    }
    const sealedUnderA = probePublishedRequest!
    expect(sealedUnderA).not.toBeNull()

    // Switch to the COLLIDING B context, then back to A.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerB,
      children: createElement(ProbeChild),
    }))
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerA,
      children: createElement(ProbeChild),
    }))

    // The stale A handle stays dead despite the colliding concatenation.
    expect(probeActions!.take(sealedUnderA!.handoffId)).toBeNull()

    // Sanity: B's own context still seals and takes its own handles.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerB,
      children: createElement(ProbeChild),
    }))
    probeActions!.publish(launchCollision, 'a')
    expect(probePublishError).toBeNull()
    const sealedUnderB = probePublishedRequest!
    void expectedCollisionContext
    view.unmount()
  })

  it('leaves pre-unmount closures without any usable handle after unmount disposes the store', () => {
    const view = renderProvider(providerValue())
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    const sealed = probePublishedRequest!
    const staleClosure = probeActions!

    view.unmount()

    // The Provider's own store was disposed on unmount: a closure captured
    // before unmount can no longer drain the sealed handle, and publishing
    // through it fails closed.
    expect(staleClosure.take(sealed.handoffId)).toBeNull()
    staleClosure.publish()
    expect((probePublishError as Error | null)?.message).toContain('disposed')
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

  it('rejects STALE closures inside a new-context subtree layout callback (take and publish)', () => {
    // The stale closure keeps the OLD committed context it captured under A.
    let staleTake: unknown = 'take-not-run'
    let stalePublishError: Error | null = null

    function StaleClosureLayoutChild({ stale }: { stale: typeof probeActions }) {
      useLayoutEffect(() => {
        // Runs during the B commit's layout phase — after the Provider's
        // insertion-phase commit, before any passive effect. The stale
        // closure's own publish records the rejection into
        // probePublishError (it catches internally).
        staleTake = stale!.take(sealedForStaleLayout!.handoffId)
        stale!.publish()
      }, [])
      return null
    }

    let sealedForStaleLayout: ProductSpaceAppLaunchRequest | null = null
    const view = render(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: createElement(ProbeChild),
    }))
    const staleClosure = probeActions
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    sealedForStaleLayout = probePublishedRequest
    expect(sealedForStaleLayout).not.toBeNull()

    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue({ activeProductSpaceId: 'space-b', productSpaceContextKey: 'account-a|space-b' }),
      children: createElement(StaleClosureLayoutChild, { stale: staleClosure }),
    }))

    // The generation + committed-live binding was advanced at the insertion
    // boundary — the stale closure can neither take nor publish.
    expect(staleTake).toBeNull()
    expect(probePublishError).toBeInstanceOf(Error)
    expect((probePublishError as Error).message).toContain('another ProductSpace context')
    void stalePublishError
    view.unmount()
  })

  it('invalidates stale closures during the sign-out unmount before layout cleanups run', () => {
    const cleanupObservations: unknown[] = []
    let sealed: ProductSpaceAppLaunchRequest | null = null

    function LayoutCleanupChild({ stale }: { stale: typeof probeActions }) {
      useLayoutEffect(() => {
        return () => {
          // Runs during unmount, after the Provider's insertion cleanup has
          // already disposed the store (sign-out teardown window). The stale
          // closure's publish records its rejection into probePublishError.
          cleanupObservations.push(stale!.take(sealed!.handoffId))
          stale!.publish()
          cleanupObservations.push(probePublishError)
        }
      }, [])
      return null
    }

    const view = render(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: createElement(ProbeChild),
    }))
    fireEvent.click(screen.getByTestId('handoff-probe-publish'))
    sealed = probePublishedRequest
    expect(sealed).not.toBeNull()
    const staleClosure = probeActions

    // Mount the cleanup probe with the ALREADY-captured stale closure.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: [
        createElement(ProbeChild),
        createElement(LayoutCleanupChild, { stale: staleClosure }),
      ],
    }))

    view.unmount()

    expect(cleanupObservations.length).toBe(2)
    expect(cleanupObservations[0]).toBeNull()
    expect(cleanupObservations[1]).toBeInstanceOf(Error)
    expect((cleanupObservations[1] as Error).message).toContain('disposed')
    void staleClosure
  })
})
