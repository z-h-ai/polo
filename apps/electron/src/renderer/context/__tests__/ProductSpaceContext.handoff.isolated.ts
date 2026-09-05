import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import {
  onProductSpaceAppLaunch,
  publishProductSpaceAppLaunch,
  takeProductSpaceAppLaunch,
  type ProductSpaceAppLaunchRequest,
} from '@/lib/product-space-app-launch-handoff'
import type { ProductSpaceContextValue } from '../ProductSpaceContext'

GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ProductSpaceProvider } = await import('../ProductSpaceContext')

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

/**
 * Probe child that exercises the REAL handoff module from inside a real
 * mounted provider: publishes on demand, records the thrown error, and takes
 * a stored handle so the assertions cover the mounted lifecycle instead of
 * calling the sync helper directly. `probePublish` keeps the closure created
 * under the mounted provider so it can be invoked after unmount — exactly
 * what a stale renderer closure would do.
 */
let probePublishError: Error | null = null
let probePublishedRequest: ProductSpaceAppLaunchRequest | null = null
let probePublish: (() => void) | null = null

function ProbeChild() {
  probePublish = () => {
    probePublishError = null
    try {
      probePublishedRequest = publishProductSpaceAppLaunch('account-a', launch)
    } catch (error) {
      probePublishError = error as Error
    }
  }
  return createElement('button', {
    type: 'button',
    'data-testid': 'handoff-probe-publish',
    onClick: () => probePublish?.(),
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

function renderProvider(value: ProductSpaceContextValue) {
  return render(createElement(ProductSpaceProvider, {
    value,
    children: createElement(ProbeChild),
  }))
}

beforeEach(() => {
  probePublishError = null
  probePublishedRequest = null
  probePublish = null
})

afterEach(() => {
  cleanup()
})

describe('ProductSpaceProvider launch handoff lifecycle', () => {
  it('seals and takes a handoff while the provider is mounted', async () => {
    renderProvider(providerValue())
    fireEventClick('handoff-probe-publish')
    expect(probePublishError).toBeNull()
    const request = probePublishedRequest!
    expect(takeProductSpaceAppLaunch(request.handoffId, expectedContext)).not.toBeNull()
  })

  it('fails closed after the provider unmounts: no take, no publish from old closures', async () => {
    const view = renderProvider(providerValue())
    fireEventClick('handoff-probe-publish')
    const sealed = probePublishedRequest!

    view.unmount()

    // The stale sealed handle must be unusable after unmount.
    expect(takeProductSpaceAppLaunch(sealed.handoffId, expectedContext)).toBeNull()
    // An old renderer closure created under the mounted provider must not be
    // able to publish for a signed-out context either.
    probePublish!()
    expect((probePublishError as Error | null)?.message).toContain('requires an active ProductSpace')
  })

  it('fails closed across a space switch and re-arms after re-authentication', async () => {
    const view = renderProvider(providerValue())
    fireEventClick('handoff-probe-publish')
    const sealedBeforeSwitch = probePublishedRequest!

    // Same mounted provider switches the committed space: the cleanup of the
    // old effect invalidates the sealed handoff BEFORE the new context binds.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue({ activeProductSpaceId: 'space-b', productSpaceContextKey: 'account-a|space-b' }),
      children: createElement(ProbeChild),
    }))
    expect(takeProductSpaceAppLaunch(sealedBeforeSwitch.handoffId, expectedContext)).toBeNull()

    // Publishing for the OLD space now fails closed…
    probePublishError = null
    fireEventClick('handoff-probe-publish')
    expect((probePublishError as Error | null)?.message).toContain('another ProductSpace context')

    // …and after re-authentication back into the original space the provider
    // seals fresh handoffs again; the pre-switch handle stays dead.
    view.rerender(createElement(ProductSpaceProvider, {
      value: providerValue(),
      children: createElement(ProbeChild),
    }))
    probePublishError = null
    fireEventClick('handoff-probe-publish')
    expect(probePublishError).toBeNull()
    const resealed = probePublishedRequest!
    expect(takeProductSpaceAppLaunch(sealedBeforeSwitch.handoffId, expectedContext)).toBeNull()
    expect(takeProductSpaceAppLaunch(resealed.handoffId, expectedContext)).not.toBeNull()
  })

  it('clears every pending handoff when the provider unmounts with several sealed', async () => {
    const unsubscribe = onProductSpaceAppLaunch(() => {})
    const view = renderProvider(providerValue())
    fireEventClick('handoff-probe-publish')
    const first = probePublishedRequest!
    fireEventClick('handoff-probe-publish')
    const second = probePublishedRequest!
    unsubscribe()

    view.unmount()

    expect(takeProductSpaceAppLaunch(first.handoffId, expectedContext)).toBeNull()
    expect(takeProductSpaceAppLaunch(second.handoffId, expectedContext)).toBeNull()
  })
})

function fireEventClick(testId: string): void {
  fireEvent.click(screen.getByTestId(testId))
}
