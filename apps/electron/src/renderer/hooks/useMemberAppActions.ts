import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CatalogApp } from '@polo-ai/shared/admin'
import { getCatalogAppIdentityKey } from '@polo-ai/shared/admin/catalog-view'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { ProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import {
  getHomeAppErrorCode,
  homeAppOperationErrorText,
} from '@/lib/home-app-errors'
import { createHomeQuickAccessContextKey } from '@/lib/home-quick-access'
import { recordHomeAppUsage } from '@/lib/home-app-usage'

/**
 * POO-70 H2 (P70-CARD-02/03): the open / prepare / permission-feedback
 * actions for member work Apps, extracted verbatim from the former HomePage
 * handlers so the home AND the future circle detail views drive the SAME
 * trusted flow.
 *
 * Authority contract (unchanged by the extraction):
 * - the launch authority stays with the injected catalog's
 *   `resolveLaunch` (fresh online grant) + the existing
 *   `launchHandoff.publish` — this hook NEVER bypasses or overrides them;
 * - a failed or refused open keeps the card (the object) in place: nothing
 *   navigates, nothing unmounts, the error surfaces as the same toasts;
 * - a refused authorization (NOT_AUTHORIZED / forbidden / cancelled install)
 *   never starts anything — INSTALL_CANCELLED stays silent, matching the
 *   cancelled-by-member permission feedback;
 * - the launched artifact is PINNED to the version the authoritative
 *   resolve returned: the prepare flow re-resolves after install and
 *   publishes THAT response, never a locally fabricated one.
 *
 * Injection contract (H1 handoff): the hook consumes the catalog instance it
 * is GIVEN. It never calls `useAppCatalog` itself and never requires a
 * mounted `MemberCatalogProvider` — during the H2 extraction the caller
 * (HomePage) keeps its original instance and passes it in, and H1's
 * `<MemberCatalogProvider catalog={...}>` may wrap the consuming subtree with
 * that same instance without creating a second one.
 */

/** A resolved launch of a locally deliverable App bundle (fixed version). */
export type MemberAppBundleLaunch = ResolveLaunchResponse & {
  subject: Extract<ResolveLaunchResponse['subject'], { kind: 'artifact_instance' }>
  delivery: Extract<ResolveLaunchResponse['delivery'], { kind: 'bundle' }>
}

export function isMemberAppBundleLaunch(
  launch: ResolveLaunchResponse,
): launch is MemberAppBundleLaunch {
  return launch.subject.kind === 'artifact_instance'
    && launch.subject.artifactType === 'app'
    && launch.delivery.kind === 'bundle'
}

/** An App waiting for the member's install/update confirmation. */
export interface MemberAppPrepareTarget {
  app: CatalogApp
  launch: MemberAppBundleLaunch
}

export type MemberAppOperationKind = 'open' | 'prepare'

/**
 * One in-flight action, keyed by the catalog's stable UI identity key so
 * consumers can reflect a busy state on exactly one card.
 */
export interface MemberAppOperationState {
  identityKey: string
  operation: MemberAppOperationKind
}

export interface MemberAppActionsContext {
  /** Space kind selecting the authorization-loss wording, as before. */
  spaceKind: 'personal' | 'enterprise' | null
  /** The existing launch handoff surface (same instance the page publishes through). */
  launchHandoff: ProductSpaceAppLaunchHandoff
}

export interface UseMemberAppActionsArgs {
  context: MemberAppActionsContext
  /** THE injected authoritative catalog instance — never created here. */
  catalog: AppCatalogInstance
}

export interface MemberAppActionsApi {
  /**
   * Opens an App through the existing authorized flow: availability gate,
   * fresh `resolveLaunch` grant, bundle-prepare detour, sealed handoff
   * publish. Failures keep the card and surface the established toasts.
   */
  open: (app: CatalogApp) => Promise<void>
  /** Confirms the pending prepare (install/update), then launches the freshly re-resolved bundle. */
  confirmPrepare: () => Promise<void>
  /** Dismisses the pending prepare without installing. */
  cancelPrepare: () => void
  /** The App currently waiting for the member's install/update confirmation. */
  prepareTarget: MemberAppPrepareTarget | null
  /** In-flight actions by UI identity key; empty when everything settled. */
  operationStates: Readonly<Record<string, MemberAppOperationState>>
}

export function useMemberAppActions({
  context,
  catalog,
}: UseMemberAppActionsArgs): MemberAppActionsApi {
  const { t } = useTranslation()
  const { spaceKind, launchHandoff } = context
  const [prepareTarget, setPrepareTarget] = useState<MemberAppPrepareTarget | null>(null)
  const prepareTargetRef = useRef<MemberAppPrepareTarget | null>(null)
  const inFlight = useRef(new Set<string>())
  const [operationStates, setOperationStates] = useState<
    Record<string, MemberAppOperationState>
  >({})

  // Match directory rows and persistent usage records. Runtime UI keys use
  // a different tuple prefix and cannot address these consumers' cards.
  const identityKeyFor = useCallback((app: CatalogApp): string => {
    const snapshot = catalog.state.catalog
    return snapshot ? getCatalogAppIdentityKey(snapshot, app) : app.id
  }, [catalog])

  const beginOperation = useCallback((
    app: CatalogApp,
    operation: MemberAppOperationKind,
  ): string | null => {
    const identityKey = identityKeyFor(app)
    // React state is presentation only: two events can arrive before render.
    if (inFlight.current.has(identityKey)) return null
    inFlight.current.add(identityKey)
    setOperationStates(previous => ({
      ...previous,
      [identityKey]: { identityKey, operation },
    }))
    return identityKey
  }, [identityKeyFor])

  const endOperation = useCallback((identityKey: string): void => {
    inFlight.current.delete(identityKey)
    setOperationStates(previous => {
      if (!(identityKey in previous)) return previous
      const next = { ...previous }
      delete next[identityKey]
      return next
    })
  }, [])

  const open = useCallback(async (app: CatalogApp): Promise<void> => {
    if (app.availability !== 'available') {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    const identityKey = beginOperation(app, 'open')
    if (!identityKey) return
    const usageContextKey = catalog.productSpace?.productSpaceContextKey
    try {
      // A pending confirmation owns its grant; repeated opens cannot replace
      // it or create another confirmation while the modal is already shown.
      if (prepareTargetRef.current) return
      const accountId = catalog.state.catalog?.accountId
      if (!accountId) throw new Error(t('homeApps.errors.staleContext'))
      const launch = await catalog.resolveLaunch(app)
      if (isMemberAppBundleLaunch(launch)) {
        const installState = catalog.getInstallState(app)
        if (
          installState?.state !== 'installed'
          || installState.currentVersion !== launch.subject.version
        ) {
          if (!prepareTargetRef.current) {
            prepareTargetRef.current = { app, launch }
            setPrepareTarget(prepareTargetRef.current)
          }
          return
        }
      }
      launchHandoff.publish(accountId, launch)
      if (usageContextKey) {
        recordHomeAppUsage(createHomeQuickAccessContextKey(usageContextKey), identityKey)
      }
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'open', spaceKind),
      })
    } finally {
      endOperation(identityKey)
    }
  }, [beginOperation, catalog, endOperation, launchHandoff, spaceKind, t])

  const confirmPrepare = useCallback(async (): Promise<void> => {
    const target = prepareTargetRef.current
    if (!target) return
    const identityKey = beginOperation(target.app, 'prepare')
    if (!identityKey) return
    prepareTargetRef.current = null
    setPrepareTarget(null)
    const { app } = target
    const usageContextKey = catalog.productSpace?.productSpaceContextKey
    try {
      await catalog.installProductSpaceBundle(app)
      toast.success(t('homeApps.toast.installed', { name: app.name }))
      const accountId = catalog.state.catalog?.accountId
      if (!accountId) throw new Error(t('homeApps.errors.staleContext'))
      const launch = await catalog.resolveLaunch(app)
      if (!isMemberAppBundleLaunch(launch)) {
        throw new Error(t('homeApps.errors.staleContext'))
      }
      launchHandoff.publish(accountId, launch)
      if (usageContextKey) {
        recordHomeAppUsage(createHomeQuickAccessContextKey(usageContextKey), identityKey)
      }
    } catch (error) {
      if (getHomeAppErrorCode(error) !== 'INSTALL_CANCELLED') {
        toast.error(t('homeApps.errors.installTitle', { name: app.name }), {
          description: homeAppOperationErrorText(t, error, 'install', spaceKind),
        })
      }
    } finally {
      endOperation(identityKey)
    }
  }, [beginOperation, catalog, endOperation, launchHandoff, spaceKind, t])

  const cancelPrepare = useCallback((): void => {
    prepareTargetRef.current = null
    setPrepareTarget(null)
  }, [])

  return {
    open,
    confirmPrepare,
    cancelPrepare,
    prepareTarget,
    operationStates,
  }
}
