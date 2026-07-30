import { describe, expect, it } from 'bun:test'
import type { TFunction } from 'i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'
import {
  primaryActionFor,
  statusText,
} from '../OrganizationAppCard'

const app: CatalogApp = {
  id: 'catalog-app',
  organizationId: 'organization-a',
  name: 'Catalog App',
  description: '',
  deliveryMode: 'local_bundle',
  currentRelease: {
    version: '1.0.0.1',
    runtime: 'static',
    downloadUrl: 'https://example.com/app.zip',
    checksum: 'a'.repeat(64),
    sizeBytes: 1,
  },
  sortOrder: 0,
  availability: 'available',
}

const translate = ((key: string) => key) as TFunction

describe('OrganizationAppCard invalid version state', () => {
  it('blocks a fresh install and shows the invalid version warning', () => {
    const status: LocalAppRuntimeStatus = {
      appId: app.id,
      status: 'not_installed',
      versionError: 'invalid_semver',
    }

    expect(primaryActionFor(app, status, true, false)).toBe('unavailable')
    expect(statusText(translate, app, status, true))
      .toBe('homeApps.status.invalidVersion')
  })

  it('keeps an installed version openable while surfacing invalid release metadata', () => {
    const status: LocalAppRuntimeStatus = {
      appId: app.id,
      status: 'update_available',
      currentVersion: '1.0.0',
      availableRelease: { version: '1.1.0' },
      versionError: 'invalid_semver',
    }

    expect(primaryActionFor(app, status, true, false)).toBe('open')
    expect(statusText(translate, app, status, true))
      .toBe('homeApps.status.invalidVersion')
    expect(status.availableRelease?.version).toBe('1.1.0')
  })

  it('prioritizes an available update while a previous version is running', () => {
    const status: LocalAppRuntimeStatus = {
      appId: app.id,
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      availableRelease: { version: '2.0.0' },
    }

    expect(primaryActionFor(app, status, true, false)).toBe('update')
    expect(primaryActionFor(app, status, true, true)).toBe('open')
    expect(statusText(translate, app, status, true))
      .toBe('homeApps.status.updateAvailable')
  })

  it('does not expose a raw runtime error message for a broken app', () => {
    const status: LocalAppRuntimeStatus = {
      appId: app.id,
      status: 'broken',
      error: {
        code: 'START_FAILED',
        message: 'secret backend stack detail',
      },
    }

    expect(statusText(translate, app, status, true))
      .toBe('homeApps.errors.openGeneric')
  })
})
