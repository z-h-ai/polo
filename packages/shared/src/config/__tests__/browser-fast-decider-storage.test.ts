import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-ai-config-fast-decider-'))
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

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      llmConnections: [],
    }, null, 2),
    'utf-8',
  )

  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getBrowserFastDeciderConfig, setBrowserFastDeciderEnabled } from '${STORAGE_MODULE_PATH}'; ${code}`,
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

describe('browser fast decider storage (POO-113 admin rollout switch)', () => {
  it('seeds the full default shape when the field is absent (r1 review nit)', () => {
    const { configDir, configPath } = setupConfigDir()

    const output = runEval(configDir, 'setBrowserFastDeciderEnabled(false); console.log(JSON.stringify(getBrowserFastDeciderConfig()))')

    expect(JSON.parse(output)).toEqual({ enabled: false, timeoutMs: 3000, paths: [] })
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.browserFastDecider).toEqual({ enabled: false, timeoutMs: 3000, paths: [] })
  })

  it('keeps the default-on semantics when written with enabled=true', () => {
    const { configDir, configPath } = setupConfigDir()

    const output = runEval(configDir, 'setBrowserFastDeciderEnabled(true); console.log(JSON.stringify(getBrowserFastDeciderConfig()))')

    expect(JSON.parse(output)).toEqual({ enabled: true, timeoutMs: 3000, paths: [] })
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.browserFastDecider).toEqual({ enabled: true, timeoutMs: 3000, paths: [] })
  })

  it('preserves existing timeoutMs/paths and only flips enabled', () => {
    const { configDir, configPath } = setupConfigDir()
    const existingConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
    existingConfig.browserFastDecider = {
      enabled: true,
      timeoutMs: 5000,
      paths: [{ name: 'A', connectionSlug: 'fast-model', model: 'ignored' }],
    }
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8')

    const output = runEval(configDir, 'setBrowserFastDeciderEnabled(false); console.log(JSON.stringify(getBrowserFastDeciderConfig()))')

    expect(JSON.parse(output)).toEqual({
      enabled: false,
      timeoutMs: 5000,
      paths: [{ name: 'A', connectionSlug: 'fast-model', model: 'ignored' }],
    })
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.browserFastDecider).toEqual({
      enabled: false,
      timeoutMs: 5000,
      paths: [{ name: 'A', connectionSlug: 'fast-model', model: 'ignored' }],
    })
  })
})
