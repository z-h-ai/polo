import { describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

// U1 (product-closure 2026-10-27) — removeWorkspace must speak honestly:
// the config entry going away is NOT the same as the on-disk data going
// away. Each case runs in a subprocess with an isolated POLO_AI_CONFIG_DIR
// (same pattern as storage-update-llm-connection.test.ts) so the global
// config singleton never leaks between cases.

function setup(workspaceIds: string[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-ai-config-'))
  const workspacesDir = join(configDir, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: workspaceIds.map(id => ({ id, name: id, rootPath: join(configDir, 'roots', id), createdAt: Date.now() })),
      activeWorkspaceId: workspaceIds[0] ?? null,
      activeSessionId: null,
      defaultLlmConnection: null,
      llmConnections: [],
    }, null, 2),
    'utf-8',
  )
  return { configDir, workspacesDir }
}

function runRemove(configDir: string, workspaceId: string): unknown {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { removeWorkspace } from '${STORAGE_MODULE_PATH}';` +
    ` process.stdout.write(JSON.stringify(await removeWorkspace(${JSON.stringify(workspaceId)})));`,
  ], {
    env: { ...process.env, POLO_AI_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(`removeWorkspace subprocess failed: ${run.stderr.toString()}`)
  }
  const out = run.stdout.toString().trim()
  return out ? JSON.parse(out) : undefined
}

describe('removeWorkspace outcome (U1 honest removal)', () => {
  it('reports removed:false when the id is not in the config (another window won)', () => {
    const { configDir } = setup(['ws-1'])
    const outcome = runRemove(configDir, 'ws-missing') as { removed: boolean; dataCleanupFailure?: unknown }
    expect(outcome.removed).toBe(false)
    expect(outcome.dataCleanupFailure).toBeUndefined()
  })

  it('reports a clean removed:true when there is no on-disk data directory', () => {
    const { configDir } = setup(['ws-1'])
    const outcome = runRemove(configDir, 'ws-1') as { removed: boolean }
    expect(outcome).toEqual({ removed: true })
  })

  it('reports the partial failure (removed:true + dataCleanupFailure) when the data dir survives', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Root ignores permission bits — the EACCES precondition cannot be built.
      return
    }
    const { configDir, workspacesDir } = setup(['ws-data'])
    const dataDir = join(workspacesDir, 'ws-data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'session-data.json'), '{}', 'utf-8')
    // Strip write permission so rmSync cannot delete the child file.
    chmodSync(dataDir, 0o500)
    try {
      const outcome = runRemove(configDir, 'ws-data') as {
        removed: boolean
        dataCleanupFailure?: { path: string; message: string }
      }
      // The config entry IS gone (removed:true) — but the data folder
      // survival must surface as a partial failure, never a clean success.
      expect(outcome.removed).toBe(true)
      expect(outcome.dataCleanupFailure?.path).toBe(dataDir)
      expect(outcome.dataCleanupFailure?.message.length).toBeGreaterThan(0)
      expect(existsSync(join(dataDir, 'session-data.json'))).toBe(true)
    } finally {
      chmodSync(dataDir, 0o700)
    }
  })
})
