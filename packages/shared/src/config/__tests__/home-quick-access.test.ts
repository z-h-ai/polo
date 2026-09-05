import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const QUICK_ACCESS_MODULE_PATH = pathToFileURL(
  join(import.meta.dir, '..', 'home-quick-access.ts'),
).href
const PREFERENCES_MODULE_PATH = pathToFileURL(
  join(import.meta.dir, '..', 'preferences.ts'),
).href
const SETTINGS_RPC_MODULE_PATH = pathToFileURL(
  join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'server-core',
    'src',
    'handlers',
    'rpc',
    'settings.ts',
  ),
).href

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import {
      getHomeQuickAccess,
      setHomeQuickAccess,
    } from '${PREFERENCES_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, POLO_AI_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString())
  }
  return run.stdout.toString().trim()
}

function runRpcEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      import { registerSettingsHandlers } from '${SETTINGS_RPC_MODULE_PATH}';
      const handlers = new Map();
      registerSettingsHandlers({
        handle: (channel, handler) => handlers.set(channel, handler),
      }, {});
      ${code}
    `,
  ], {
    env: { ...process.env, POLO_AI_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString())
  }
  return run.stdout.toString().trim()
}

describe('Home quick-access preferences', () => {
  it('keeps personal and enterprise home configurations isolated per space', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'polo-home-quick-'))
    const personalContext = 'v1:["account-a","space:personal"]'
    const enterpriseContext = 'v1:["account-a","space:enterprise"]'
    runEval(configDir, `
      setHomeQuickAccess(${JSON.stringify(personalContext)}, [
        { id: '["catalog","account-a","space:personal","app-1"]', addedAt: 1 },
      ]);
      setHomeQuickAccess(${JSON.stringify(enterpriseContext)}, [
        { id: '["catalog","account-a","space:enterprise","app-2"]', addedAt: 2 },
      ]);
    `)

    const personal = runEval(
      configDir,
      `console.log(JSON.stringify(getHomeQuickAccess(${
        JSON.stringify(personalContext)
      })))`,
    )
    const enterprise = runEval(
      configDir,
      `console.log(JSON.stringify(getHomeQuickAccess(${
        JSON.stringify(enterpriseContext)
      })))`,
    )

    expect(JSON.parse(personal)).toEqual([
      { id: '["catalog","account-a","space:personal","app-1"]', addedAt: 1 },
    ])
    expect(JSON.parse(enterprise)).toEqual([
      { id: '["catalog","account-a","space:enterprise","app-2"]', addedAt: 2 },
    ])
    const preferences = JSON.parse(
      readFileSync(join(configDir, 'preferences.json'), 'utf8'),
    )
    expect(Object.keys(preferences.homeQuickAccess).sort())
      .toEqual([personalContext, enterpriseContext].sort())
  })

  it('caps the slots at five and preserves the explicit order', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'polo-home-quick-cap-'))
    const contextKey = 'v1:["account-a","space:personal"]'
    const saved = runEval(configDir, `
      const apps = [1, 2, 3, 4, 5, 6].map(index => ({
        id: '["catalog","account-a","space:personal","app-' + index + '"]',
        addedAt: index,
      }));
      console.log(JSON.stringify(setHomeQuickAccess(${
        JSON.stringify(contextKey)
      }, apps)));
    `)
    // The first five entries win; the sixth is dropped. Insertion order is
    // preserved (unlike recency-sorted launcher history).
    expect(JSON.parse(saved)).toHaveLength(5)
    expect(JSON.parse(saved).map((app: { id: string }) => app.id)).toEqual([
      '["catalog","account-a","space:personal","app-1"]',
      '["catalog","account-a","space:personal","app-2"]',
      '["catalog","account-a","space:personal","app-3"]',
      '["catalog","account-a","space:personal","app-4"]',
      '["catalog","account-a","space:personal","app-5"]',
    ])

    const reloaded = runEval(
      configDir,
      `console.log(JSON.stringify(getHomeQuickAccess(${
        JSON.stringify(contextKey)
      })))`,
    )
    expect(JSON.parse(reloaded)).toHaveLength(5)
  })

  it('round-trips quick access through the settings RPC channels', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'polo-home-quick-rpc-'))
    const entityId = '\0'.repeat(512)
    const contextKey = `v1:${JSON.stringify([entityId, entityId])}`
    const scopeKeyId = JSON.stringify([
      'catalog',
      entityId,
      entityId,
      entityId,
    ])

    runRpcEval(configDir, `
      await handlers.get('preferences:setHomeQuickAccess')({}, ${
        JSON.stringify(contextKey)
      }, [{
        id: ${JSON.stringify(scopeKeyId)},
        addedAt: 42,
      }]);
    `)

    const reloaded = runRpcEval(
      configDir,
      `console.log(JSON.stringify(
        await handlers.get('preferences:getHomeQuickAccess')({}, ${
          JSON.stringify(contextKey)
        }),
      ))`,
    )
    expect(JSON.parse(reloaded)).toEqual([{
      id: scopeKeyId,
      addedAt: 42,
    }])
  })

  it('sanitizes malformed entries while preserving order', () => {
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { sanitizeHomeQuickAccess } from '${QUICK_ACCESS_MODULE_PATH}';
        console.log(JSON.stringify(sanitizeHomeQuickAccess([
          { id: 'b', addedAt: 2 },
          { id: 'a', addedAt: 1 },
          { id: 'b', addedAt: 9 },
          null,
          { id: '', addedAt: 3 },
          { id: 'c' },
          { id: 'd', addedAt: Number.NaN },
        ])));`,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toEqual([
      { id: 'b', addedAt: 2 },
      { id: 'a', addedAt: 1 },
    ])
  })
})
