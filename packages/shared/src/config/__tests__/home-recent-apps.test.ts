import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PREFERENCES_MODULE_PATH = pathToFileURL(
  join(import.meta.dir, '..', 'preferences.ts'),
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
})
