import { describe, expect, it } from 'bun:test'
import { createInstance } from 'i18next'
import { LOCALE_REGISTRY } from '@polo-ai/shared/i18n/registry'
import type {
  TerminalIntegrationErrorCode,
  TerminalIntegrationStatus,
} from '../../../shared/types'
import {
  getTerminalIntegrationErrorMessage,
  getTerminalIntegrationStatusMessage,
} from '../terminal-integration-status'

function status(
  statusCode: TerminalIntegrationStatus['statusCode'],
  path?: string,
): TerminalIntegrationStatus {
  return {
    supported: true,
    installed: statusCode === 'ready' || statusCode === 'repair_required',
    pathReady: statusCode === 'ready',
    needsRepair: statusCode === 'repair_required',
    statusCode,
    statusParams: path ? { path } : undefined,
    launcherPath: '/Users/test/.local/bin/polo',
  }
}

describe('terminal integration status i18n', () => {
  it('renders every structured status in every locale', async () => {
    const codes: TerminalIntegrationStatus['statusCode'][] = [
      'managed_by_installer',
      'profile_conflict',
      'launcher_conflict',
      'command_conflict',
      'ready',
      'repair_required',
      'not_installed',
    ]

    for (const [language, locale] of Object.entries(LOCALE_REGISTRY)) {
      const instance = createInstance()
      await instance.init({
        lng: language,
        fallbackLng: false,
        interpolation: { escapeValue: false },
        resources: { [language]: { translation: locale.messages } },
      })
      for (const code of codes) {
        const message = getTerminalIntegrationStatusMessage(
          status(code, '/opt/tools/polo'),
          instance.t,
        )
        expect(message).not.toStartWith('settings.terminalFeatures.status.')
        expect(message.length).toBeGreaterThan(0)
        if (code.endsWith('conflict')) {
          expect(message).toContain('/opt/tools/polo')
        }
      }
    }
  })

  it('does not leak English conflict copy into Simplified Chinese', async () => {
    const instance = createInstance()
    await instance.init({
      lng: 'zh-Hans',
      fallbackLng: false,
      interpolation: { escapeValue: false },
      resources: {
        'zh-Hans': { translation: LOCALE_REGISTRY['zh-Hans'].messages },
      },
    })
    const message = getTerminalIntegrationStatusMessage(
      status('command_conflict', '/opt/tools/polo'),
      instance.t,
    )
    expect(message).toContain('/opt/tools/polo')
    expect(message).toContain('已有')
    expect(message).not.toContain('Another command')
  })

  it('renders every structured exception in every locale', async () => {
    const codes: TerminalIntegrationErrorCode[] = [
      'unsupported_platform',
      'profile_malformed',
      'status_failed',
      'install_failed',
      'uninstall_failed',
      'ipc_failed',
    ]

    for (const [language, locale] of Object.entries(LOCALE_REGISTRY)) {
      const instance = createInstance()
      await instance.init({
        lng: language,
        fallbackLng: false,
        interpolation: { escapeValue: false },
        resources: { [language]: { translation: locale.messages } },
      })
      for (const errorCode of codes) {
        const message = getTerminalIntegrationErrorMessage({
          errorCode,
          errorParams: {
            path: '/Users/test/.zprofile',
            operation: 'install',
          },
        }, instance.t)
        expect(message).not.toStartWith('settings.terminalFeatures.error.')
        expect(message.length).toBeGreaterThan(0)
        if (errorCode === 'profile_malformed') {
          expect(message).toContain('/Users/test/.zprofile')
        }
      }
    }
  })
})
