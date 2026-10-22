/**
 * Controlled fixtures for the source baseline.
 *
 * Scope: fixtures only drive UI presentation for components that normally
 * talk to the Electron main process. They replace BACKEND DATA, never the
 * components themselves — every rendered element comes from the real
 * renderer sources on this branch. Fixtures do not represent real backend
 * behavior and must not be read as API contracts.
 *
 * Typed against the real shared contracts (satisfies) so a drifted shape
 * fails typecheck instead of silently rendering blank; this directory is
 * covered by tools/source-baseline/tsconfig.json.
 */
import type { ProductSpaceContextValue } from '@/context/ProductSpaceContext'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type {
  MemberCircleSnapshot,
  MemberMembership,
  MemberCircleEntitlement,
} from '@polo-ai/shared/admin'
import { ProductSpaceSummarySchema } from '@polo-ai/shared/product-spaces'
import { mockSources } from '@/playground/mock-utils'

// Parsed through the real shared schema — a drifted fixture fails loudly
// instead of masquerading as a valid personal space.
export const fixtureProductSpace: ProductSpaceSummary = ProductSpaceSummarySchema.parse({
  id: 'personal-space',
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
})

export const productSpaceFixture: ProductSpaceContextValue = {
  accountId: 'baseline-account',
  activeProductSpaceId: 'personal-space',
  activeProductSpace: fixtureProductSpace,
  productSpaces: [fixtureProductSpace],
  allProductSpaces: [fixtureProductSpace],
  personalProductSpaceId: 'personal-space',
  productSpaceContextKey: '["product-space",1,"baseline-account","personal-space"]',
  contextVersion: 1,
  pendingSwitch: null,
  onSelectProductSpace: () => {},
  onRefreshProductSpaces: () => {},
  onConfirmStopAndSwitch: () => {},
  onRetryFailedStops: () => {},
  onRetryTargetLoad: () => {},
  onCancelSwitch: () => {},
  onDismissTargetAccessLost: () => {},
  onStopSwitchExecution: () => {},
}

// ---------------------------------------------------------------------------
// Member circles — typed against the real shared contracts. Structure mirrors
// the isolated-test fixtures in
// apps/electron/src/renderer/components/circles/__tests__/CircleDetailPage.interaction.isolated.ts
// ---------------------------------------------------------------------------

function entitlementFixture(
  circleId: string,
  id: string,
  type: 'web_app' | 'skill',
  name: string,
): MemberCircleEntitlement {
  return {
    id,
    circleId,
    artifactId: `artifact-${id}`,
    sourceKind: 'active_distribution',
    sourceValidUntil: null,
    artifact: {
      id: `artifact-${id}`,
      type,
      slug: name,
      name,
      summary: '',
      status: 'published',
      currentStableVersionId: null,
    },
    artifactVersion: { id: `version-${id}`, version: '1.0.0', status: 'published', publishedAt: null },
  }
}

function circleSnapshotFixture(input: {
  circleId: string
  membershipId: string
  name: string
  purpose: string
  billingKind: 'free' | 'paid'
}): MemberCircleSnapshot {
  return {
    membershipId: input.membershipId,
    status: 'active',
    billingKind: input.billingKind,
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    joinSource: 'share_link',
    joinedAt: '2026-09-01T00:00:00.000Z',
    circle: {
      circleId: input.circleId,
      name: input.name,
      purpose: input.purpose,
      status: 'active',
      ownerUserId: '00000000-0000-4000-8000-000000000001',
    },
    entitlements: [
      entitlementFixture(input.circleId, `${input.circleId}-a1`, 'web_app', '增长打法手册'),
      entitlementFixture(input.circleId, `${input.circleId}-s1`, 'skill', '资料研究'),
    ],
  } satisfies MemberCircleSnapshot
}

function membershipFixture(input: {
  circleId: string
  membershipId: string
  name: string
  billingKind: 'free' | 'paid'
}): MemberMembership {
  return {
    membershipId: input.membershipId,
    status: 'active',
    billingKind: input.billingKind,
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    suspendedReason: null,
    joinedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    paymentOrders: [],
    circle: {
      circleId: input.circleId,
      name: input.name,
      purpose: '',
      status: 'active',
      joinMode: input.billingKind === 'free' ? 'free' : 'paid',
      membershipPriceMinor: input.billingKind === 'free' ? null : 2500,
      membershipCurrency: input.billingKind === 'free' ? null : 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
  } satisfies MemberMembership
}

export const fixtureCircleSnapshots: MemberCircleSnapshot[] = [
  circleSnapshotFixture({
    circleId: 'circle-baseline-monthly',
    membershipId: 'ms-monthly',
    name: '晨星增长圈',
    purpose: '每月更新的增长打法与应用',
    billingKind: 'paid',
  }),
  circleSnapshotFixture({
    circleId: 'circle-baseline-free',
    membershipId: 'ms-free',
    name: '入门指南圈',
    purpose: '免费入门内容与公开更新',
    billingKind: 'free',
  }),
]

const fixtureMemberships: MemberMembership[] = [
  membershipFixture({
    circleId: 'circle-baseline-monthly',
    membershipId: 'ms-monthly',
    name: '晨星增长圈',
    billingKind: 'paid',
  }),
  membershipFixture({
    circleId: 'circle-baseline-free',
    membershipId: 'ms-free',
    name: '入门指南圈',
    billingKind: 'free',
  }),
]

// ---------------------------------------------------------------------------
// Offline-safe icons: the playground mock sources carry external favicon URLs
// (google/s2) and the SourceAvatar fallback resolves gstatic URLs through the
// getLogoUrl IPC. A baseline artifact must render with ZERO external requests,
// so fixtures replace them with inline data-URI SVGs — same component paths,
// no network.
// ---------------------------------------------------------------------------

function inlineLetterIcon(letter: string, background: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${background}"/><text x="16" y="21.5" font-family="system-ui,sans-serif" font-size="16" font-weight="600" fill="#ffffff" text-anchor="middle">${letter}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const offlineSourceIcons: Record<string, string> = {
  'github-api': inlineLetterIcon('G', '#24292f'),
  'linear-api': inlineLetterIcon('L', '#5e6ad2'),
}

/**
 * The playground mockSources array is SHARED: the chat registry wrapper
 * imports and reads it directly (playground/registry/chat.tsx), bypassing
 * api.getSources — replacing only the IPC return value leaves the external
 * icon URLs in place. Mutate the imported fixture elements IN PLACE instead
 * (runtime fixture data only; production source files stay untouched).
 */
function installOfflineSourceIcons(): void {
  for (const source of mockSources) {
    const icon = offlineSourceIcons[source.config.slug]
    if (icon) source.config.icon = icon
  }
}

/** Patched onto window.electronAPI AFTER playground/mock-utils installs its mock. */
export function installBaselineApiFixtures(api: Record<string, unknown>) {
  // Must run before any component reads the shared mockSources array.
  installOfflineSourceIcons()
  // Auto-update / themes / tool icons — static "no update, stock themes" state.
  api.getUpdateInfo = () => Promise.resolve({
    available: false,
    currentVersion: '0.0.0-baseline',
    latestVersion: null,
    downloadState: 'idle',
    downloadProgress: 0,
  })
  api.checkForUpdates = api.getUpdateInfo
  api.getDismissedUpdateVersion = () => Promise.resolve(null)
  api.installUpdate = () => Promise.resolve()
  api.dismissUpdate = () => Promise.resolve()
  api.onUpdateAvailable = () => () => {}
  api.onUpdateDownloadProgress = () => () => {}
  api.getReleaseNotes = () => Promise.resolve('')
  api.getLatestReleaseVersion = () => Promise.resolve(undefined)
  api.getHomeDir = () => Promise.resolve('/Users/baseline')
  api.getNotificationsEnabled = () => Promise.resolve(true)
  api.getKeepAwakeWhileRunning = () => Promise.resolve(false)
  api.setKeepAwakeWhileRunning = () => Promise.resolve()
  api.getBrowserToolEnabled = () => Promise.resolve(true)
  api.setBrowserToolEnabled = () => Promise.resolve()
  api.getGenerativeUiInlineEnabled = () => Promise.resolve(true)
  api.setGenerativeUiInlineEnabled = () => Promise.resolve()
  const terminalIntegrationReady = {
    success: true as const,
    status: { supported: true, installed: true, pathReady: true, needsRepair: false, statusCode: 'ready' as const },
  }
  api.getTerminalIntegrationStatus = () => Promise.resolve(terminalIntegrationReady)
  api.loadPresetThemes = () => Promise.resolve([])
  api.getToolIconMappings = () => Promise.resolve({})
  api.localApps = {
    ...(api.localApps as object | undefined),
    getHostInfo: () => Promise.resolve({ platform: 'darwin', arch: 'arm64' }),
    getProductSpaceInstallStates: () => Promise.resolve([]),
    getProductSpaceWithdrawnInstallStates: () => Promise.resolve([]),
  }
  // Workspace / permissions / labels / server — stock "configured default" state.
  api.getWorkspaceSettings = () => Promise.resolve({}) // all-optional WorkspaceSettings
  api.onWorkspaceSettingsChanged = () => () => {}
  api.onSourcesChanged = () => () => {}
  api.getDefaultPermissionsConfig = () => Promise.resolve({
    config: null,
    path: '/Users/baseline/.polo-ai/permissions.json',
  })
  api.listLabels = () => Promise.resolve([])
  api.onLabelsChanged = () => () => {}
  api.getServerConfig = () => Promise.resolve({ enabled: false, port: 9100 })
  api.setServerConfig = () => Promise.resolve()
  api.getServerStatus = () => Promise.resolve({ running: false, host: '127.0.0.1', port: 9100, tls: false })
  api.getGenerativeUiCanvasEnabled = () => Promise.resolve(false)
  api.getWorkspacePermissionsConfig = () => Promise.resolve(null)
  api.getSources = () => Promise.resolve(mockSources)
  // Tab-shell hydration (TabShellContext): no web-app tabs in the baseline.
  api.getTabBrowserApps = () => Promise.resolve([])
  api.saveTabBrowserApps = () => Promise.resolve()
  // Favicon fallback IPC (SourceAvatar / icon-cache): production resolves this
  // main-side, possibly against a favicon service; the baseline answers with
  // an inline glyph so no request ever leaves the document.
  api.getLogoUrl = () => Promise.resolve(inlineLetterIcon('·', '#6b7280'))
  api.getNetworkProxySettings = () => Promise.resolve({ enabled: false })
  api.setNetworkProxySettings = () => Promise.resolve()
  // Writable side of the settings toggles (independent interaction probe R10):
  // every switch a settings page exposes must accept a real click. These
  // handlers complete the write in-memory ONLY — nothing persists and nothing
  // here represents real backend behavior.
  api.setNotificationsEnabled = () => Promise.resolve()
  api.setAutoCapitalisation = () => Promise.resolve()
  api.setSpellCheck = () => Promise.resolve()
  api.setSendMessageKey = () => Promise.resolve()
  api.setGenerativeUiCanvasEnabled = () => Promise.resolve()
  api.updateWorkspaceSetting = () => Promise.resolve()
  api.writePreferences = () => Promise.resolve({ success: true })
  api.writeWorkspaceImage = () => Promise.resolve()
  // Silent "file missing" — the icon loaders treat null as fallback (types.ts
  // says Promise<string>, production IPC also returns null for missing files).
  api.readWorkspaceImage = () => Promise.resolve(null as never)
  // Account-security normal state (R11): the real AccountPasswordSettingsForm
  // submits through window.electronAPI.adminSetPassword. Length/mismatch
  // validation happens in the REAL useAdminPassword hook; this handler only
  // completes an accepted write in-memory — no secret is stored anywhere.
  api.adminSetPassword = (_password: string) => Promise.resolve({ success: true })
  api.getAllWorkspaceThemes = () => Promise.resolve({})
  api.onDefaultPermissionsChanged = () => () => {}
  api.relaunchApp = () => Promise.resolve()
  api.installTerminalIntegration = () => Promise.resolve(terminalIntegrationReady)
  api.uninstallTerminalIntegration = () => Promise.resolve(terminalIntegrationReady)
  api.getMessagingSupergroup = () => Promise.resolve(null)
  api.unbindMessagingSupergroup = () => Promise.resolve({ success: true })
  api.creatorSkillListBackups = () => Promise.resolve({ success: true, backups: [] })
  api.creatorSkillDeleteBackups = () => Promise.resolve({ success: true })
  // Unified ProductSpace Catalog (S01): three available apps, two of them
  // sourced from the fixture creator circle so the home surface shows the
  // normal directory + circle relation, not a fallback empty state.
  api.productSpaceGetCatalog = () => Promise.resolve({
    success: true,
    notModified: false,
    catalogRevision: 'baseline-rev-1',
    accessMode: 'online',
    warningCode: null,
    entries: [
      {
        kind: 'app',
        catalogEntryId: 'entry-meeting-notes',
        name: '会议纪要整理',
        description: '把会议材料整理成清晰的纪要。',
        availability: 'available',
        sources: [{ kind: 'creator_circle', circleId: 'circle-baseline-monthly', name: '晨星增长圈' }],
      },
      {
        kind: 'app',
        catalogEntryId: 'entry-report-generator',
        name: '数据报表生成器',
        description: '汇总数据，生成周期报表。',
        availability: 'available',
        sources: [{ kind: 'creator_circle', circleId: 'circle-baseline-monthly', name: '晨星增长圈' }],
      },
      {
        kind: 'app',
        catalogEntryId: 'entry-direct-app',
        name: '品牌语气分析',
        description: '分析对外文案的表达与语气。',
        availability: 'available',
        sources: [{ kind: 'organization', name: 'Polo 内置' }],
      },
    ],
    withdrawnEntries: [],
  })
  api.memberCircles = {
    list: () => Promise.resolve({ success: true, circles: fixtureCircleSnapshots }),
    listMemberships: () => Promise.resolve({ success: true, memberships: fixtureMemberships }),
    previewRenewal: (_membershipId: string) => Promise.resolve({
      success: true,
      purchaseUrl: '/c/baseline-share?renew=1',
      // C1 main-side resolution of the raw provider path against the
      // controlled creator origin (renderer/circle-purchase-url.ts re-verifies
      // it; without it the panel renders the fail-closed blocked banner).
      resolvedPurchaseUrl: 'https://creator.polo.z-h-ai.com/c/baseline-share?renew=1',
      purchaseUrlResolutionError: null,
      preview: {
        membershipId: 'ms-monthly',
        circleId: 'circle-baseline-monthly',
        billingCycle: 'month',
        periodKind: 'calendar_month',
        priceMinor: 2500,
        currency: 'CNY',
        anchorAt: '2026-10-01T00:00:00.000Z',
        projectedPeriodStartAt: '2026-11-01T00:00:00.000Z',
        projectedPeriodEndAt: '2026-11-30T00:00:00.000Z',
        periodCapEndAt: '2027-10-01T00:00:00.000Z',
        canRenew: true,
        capReason: null,
      },
    }),
    leave: () => Promise.resolve({ success: false, errorCode: 'conflict', message: 'fixture: not leaveable' }),
    getOrder: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'fixture: not found' }),
    getCheckoutResult: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'fixture: not found' }),
    getUpdates: () => Promise.resolve({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
    getProfile: () => Promise.resolve({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
    getSupport: () => Promise.resolve({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
  }
}

export const adminLoginHandlers = {
  onClearError: () => {},
  onSendPhoneCode: (_phone: string) => Promise.resolve({ success: true } as never),
  onVerifyPhoneCode: () => Promise.resolve(true),
  onSubmit: () => {},
}
