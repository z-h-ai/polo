import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir(configAdminUrl?: string) {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-ai-config-admin-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      llmConnections: [],
      ...(configAdminUrl ? { adminUrl: configAdminUrl } : {}),
    }, null, 2),
    'utf-8',
  )

  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: 'test',
      description: 'test defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
        extendedPromptCache: false,
        browserToolEnabled: true,
        adminUrl: 'https://polo-admin.z-h-ai.com/',
        allowRemoteEvaluate: true,
      },
      workspaceDefaults: {
        thinkingLevel: 'medium',
        permissionMode: 'ask',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
        localMcpServers: { enabled: true },
      },
    }, null, 2),
    'utf-8',
  )

  return configDir
}

function readAdminUrl(configDir: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getAdminUrl } from '${STORAGE_MODULE_PATH}'; console.log(getAdminUrl() ?? '')`,
  ], {
    env: { ...process.env, POLO_AI_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

function saveEmptyConfig(configDir: string): void {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { saveConfig } from '${STORAGE_MODULE_PATH}'; saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })`,
  ], {
    env: { ...process.env, POLO_AI_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }
}

describe('admin URL defaults', () => {
  it('falls back to config-defaults adminUrl when config.json does not set one', () => {
    expect(readAdminUrl(setupConfigDir())).toBe('https://polo-admin.z-h-ai.com/')
  })

  it('preserves an explicit config.json adminUrl over the default', () => {
    expect(readAdminUrl(setupConfigDir('https://admin.example.com/'))).toBe('https://admin.example.com/')
  })

  it('writes the default adminUrl into config.json when saving a new config', () => {
    const configDir = setupConfigDir()
    saveEmptyConfig(configDir)

    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'))
    expect(config.adminUrl).toBe('https://polo-admin.z-h-ai.com/')
  })
})
