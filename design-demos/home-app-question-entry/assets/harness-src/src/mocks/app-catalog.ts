import { useMemo } from 'react'
import type { AppCatalogCacheEntry, CatalogApp } from '@z-h-ai/shared/admin'
import {
  createLocalAppScopeKey,
  type CatalogLocalAppScope,
  type LocalAppRuntimeStatus,
} from '@z-h-ai/shared/protocol'

const accountId = 'review-account'
const organizationId = 'northstar-studio'

function queryParameters() {
  const query = new URLSearchParams(window.location.search)
  return {
    scene: query.get('scene') === 'offline' ? 'offline' : 'catalog',
    lang: query.get('lang') === 'en' ? 'en' : 'zh-Hans',
  } as const
}

function scopeFor(app: CatalogApp): CatalogLocalAppScope {
  return {
    kind: 'catalog',
    accountId,
    organizationId,
    catalogAppId: app.id,
  }
}

function fixtureCatalog(lang: 'zh-Hans' | 'en'): {
  catalog: AppCatalogCacheEntry
  statuses: Record<string, LocalAppRuntimeStatus>
} {
  const zh = lang === 'zh-Hans'
  const apps: CatalogApp[] = [
    {
      id: 'insight-hub',
      organizationId,
      name: zh ? '数据洞察' : 'Insight Hub',
      description: zh
        ? '集中查看团队指标、客户反馈与每周洞察。'
        : 'Review team metrics, customer feedback, and weekly insights.',
      creatorName: zh ? '北极星工作室' : 'Northstar Studio',
      deliveryMode: 'local_bundle',
      currentRelease: {
        version: '2.3.0',
        runtime: 'static',
        downloadUrl: 'https://downloads.example/insight-hub.zip',
        checksum: 'sha256:insight',
        sizeBytes: 18_874_368,
        platform: 'darwin',
        arch: 'arm64',
      },
      sortOrder: 0,
      availability: 'available',
    },
    {
      id: 'campaign-studio',
      organizationId,
      name: zh ? '营销工作台' : 'Campaign Studio',
      description: zh
        ? '创建、审阅并发布团队营销内容。'
        : 'Create, review, and publish campaign content.',
      creatorName: zh ? '北极星工作室' : 'Northstar Studio',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://campaign.example',
      sortOrder: 1,
      availability: 'available',
    },
    {
      id: 'client-portal',
      organizationId,
      name: zh ? '客户门户' : 'Client Portal',
      description: zh
        ? '管理客户交付、共享资料和项目状态。'
        : 'Manage client deliveries, shared files, and project status.',
      creatorName: zh ? '北极星工作室' : 'Northstar Studio',
      deliveryMode: 'local_bundle',
      currentRelease: {
        version: '2.4.0',
        runtime: 'js',
        downloadUrl: 'https://downloads.example/client-portal.zip',
        checksum: 'sha256:portal',
        sizeBytes: 42_991_616,
        platform: 'darwin',
        arch: 'arm64',
      },
      sortOrder: 2,
      availability: 'available',
    },
  ]
  const insightScope = scopeFor(apps[0])
  const portalScope = scopeFor(apps[2])
  return {
    catalog: {
      accountId,
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'review-v1',
      syncedAt: Date.now(),
      apps,
      withdrawnApps: [],
      trustedReleases: {},
      warnings: [],
    },
    statuses: {
      [createLocalAppScopeKey(insightScope)]: {
        appId: apps[0].id,
        scope: insightScope,
        status: 'stopped',
        currentVersion: '2.3.0',
      },
      [createLocalAppScopeKey(portalScope)]: {
        appId: apps[2].id,
        scope: portalScope,
        status: 'update_available',
        currentVersion: '2.3.1',
        availableRelease: {
          version: '2.4.0',
        },
      },
    },
  }
}

export function useAppCatalog() {
  const parameters = queryParameters()
  return useMemo(() => {
    const { catalog, statuses } = fixtureCatalog(parameters.lang)
    const getStatus = (app: CatalogApp) => statuses[
      createLocalAppScopeKey(scopeFor(app))
    ]
    return {
      organization: {
        accountId,
        activeOrganizationId: organizationId,
        organizationContextKey: `${accountId}:${organizationId}`,
        organizationSummaries: [{
          id: organizationId,
          type: 'creator_space' as const,
          name: parameters.lang === 'zh-Hans'
            ? '北极星工作室'
            : 'Northstar Studio',
          purpose: '',
          memberCount: 16,
          membership: {
            id: 'membership-review',
            organizationId,
            userId: accountId,
            role: 'member' as const,
            status: 'active' as const,
          },
        }],
      },
      state: {
        catalog,
        loading: false,
        refreshing: false,
        warningCode: parameters.scene === 'offline' ? 'NETWORK_ERROR' : null,
        errorCode: null,
        statusErrorCode: null,
        statusErrorScopeKeys: {},
        accessMode: parameters.scene === 'offline' ? 'offline' : 'online',
        statuses,
        host: {
          platform: 'darwin' as const,
          arch: 'arm64' as const,
        },
      },
      sync: async () => {},
      install: async () => {},
      start: async (app: CatalogApp) => ({
        appId: app.id,
        scope: scopeFor(app),
        version: app.currentRelease?.version ?? '1.0.0',
        url: 'http://127.0.0.1:41731',
        port: 41731,
      }),
      stop: async () => {},
      uninstall: async () => {},
      cancelInstall: async () => {},
      getLogs: async () => '',
      resolveRemoteUrl: async (app: CatalogApp) => app.remoteUrl ?? '',
      getStatus,
      scopeForApp: scopeFor,
      scopeKeyForApp: (app: CatalogApp) => createLocalAppScopeKey(scopeFor(app)),
      refreshRuntimeStatuses: async () => {},
    }
  }, [parameters.lang, parameters.scene])
}
