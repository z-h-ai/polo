import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    `import { getHomeRecentApps, setHomeRecentApps } from '${
      PREFERENCES_MODULE_PATH
    }'; ${code}`,
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
      import { registerSettingsHandlers } from '${
        SETTINGS_RPC_MODULE_PATH
      }';
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

describe('Home recent App preferences', () => {
  it('round-trips isolated context histories across processes', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'polo-home-recents-'))
    const firstContext = 'v2:["account-a","organization:a"]'
    const secondContext = 'v2:["account-b","organization:a"]'
    runEval(configDir, `
      setHomeRecentApps(${JSON.stringify(firstContext)}, [
        { id: 'app-a', kind: 'organization', openedAt: 1 },
      ]);
      setHomeRecentApps(${JSON.stringify(secondContext)}, [
        { id: 'app-b', kind: 'organization', openedAt: 2 },
      ]);
    `)

    const first = runEval(
      configDir,
      `console.log(JSON.stringify(getHomeRecentApps(${
        JSON.stringify(firstContext)
      })))`,
    )
    const second = runEval(
      configDir,
      `console.log(JSON.stringify(getHomeRecentApps(${
        JSON.stringify(secondContext)
      })))`,
    )

    expect(JSON.parse(first)).toEqual([
      { id: 'app-a', kind: 'organization', openedAt: 1 },
    ])
    expect(JSON.parse(second)).toEqual([
      { id: 'app-b', kind: 'organization', openedAt: 2 },
    ])
    const preferences = JSON.parse(
      readFileSync(join(configDir, 'preferences.json'), 'utf8'),
    )
    expect(Object.keys(preferences.homeRecentApps).sort())
      .toEqual([firstContext, secondContext].sort())
  })

  it('round-trips maximum NUL entity IDs across a fresh process', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'polo-home-recents-max-'))
    const entityId = '\0'.repeat(512)
    const contextKey = `v2:${JSON.stringify([entityId, entityId])}`
    const recentAppId = JSON.stringify([
      'catalog',
      entityId,
      entityId,
      entityId,
    ])

    expect(contextKey).toHaveLength(6_154)
    expect(recentAppId).toHaveLength(9_236)
    runRpcEval(configDir, `
      await handlers.get('preferences:setHomeRecentApps')({}, ${
        JSON.stringify(contextKey)
      }, [{
        id: ${JSON.stringify(recentAppId)},
        kind: 'organization',
        openedAt: 42,
      }]);
    `)

    const reloaded = runRpcEval(
      configDir,
      `console.log(JSON.stringify(
        await handlers.get('preferences:getHomeRecentApps')({}, ${
          JSON.stringify(contextKey)
        }),
      ))`,
    )
    expect(JSON.parse(reloaded)).toEqual([{
      id: recentAppId,
      kind: 'organization',
      openedAt: 42,
    }])
  })
})
