import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { ProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import {
  getHomeAppErrorCode,
  homeAppOperationErrorText,
} from '@/lib/home-app-errors'

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
  const [operationStates, setOperationStates] = useState<
    Record<string, MemberAppOperationState>
  >({})

  // UI identity key of the CURRENT catalog instance; a failed derivation is
  // not fatal for an in-flight marker, it only degrades to the raw id.
  const identityKeyFor = useCallback((app: CatalogApp): string => {
    try {
      return catalog.uiIdentityKeyForApp(app)
    } catch {
      return app.id
    }
  }, [catalog])

  const beginOperation = useCallback((
    app: CatalogApp,
    operation: MemberAppOperationKind,
  ): string => {
    const identityKey = identityKeyFor(app)
    setOperationStates(previous => ({
      ...previous,
      [identityKey]: { identityKey, operation },
    }))
    return identityKey
  }, [identityKeyFor])

  const endOperation = useCallback((identityKey: string): void => {
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
    try {
      const accountId = catalog.state.catalog?.accountId
      if (!accountId) throw new Error(t('homeApps.errors.staleContext'))
      const launch = await catalog.resolveLaunch(app)
      if (isMemberAppBundleLaunch(launch)) {
        const installState = catalog.getInstallState(app)
        if (
          installState?.state !== 'installed'
          || installState.currentVersion !== launch.subject.version
        ) {
          setPrepareTarget({ app, launch })
          return
        }
      }
      launchHandoff.publish(accountId, launch)
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'open', spaceKind),
      })
    } finally {
      endOperation(identityKey)
    }
  }, [beginOperation, catalog, endOperation, launchHandoff, spaceKind, t])

  const confirmPrepare = useCallback(async (): Promise<void> => {
    const target = prepareTarget
    if (!target) return
    setPrepareTarget(null)
    const { app } = target
    const identityKey = beginOperation(app, 'prepare')
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
    } catch (error) {
      if (getHomeAppErrorCode(error) !== 'INSTALL_CANCELLED') {
        toast.error(t('homeApps.errors.installTitle', { name: app.name }), {
          description: homeAppOperationErrorText(t, error, 'install', spaceKind),
        })
      }
    } finally {
      endOperation(identityKey)
    }
  }, [beginOperation, catalog, endOperation, launchHandoff, prepareTarget, spaceKind, t])

  const cancelPrepare = useCallback((): void => {
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
