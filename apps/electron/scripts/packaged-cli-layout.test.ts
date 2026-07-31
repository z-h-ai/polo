import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  validatePackagedCliLayout,
} = require('./packaged-cli-layout.cjs') as {
  validatePackagedCliLayout(options: {
    resourcesDir: string
    platform: string
    expectedVersion: string
  }): { appDir: string; server: string; polo: string; poloAi: string }
}

const roots: string[] = []
const sourceBin = join(import.meta.dir, '..', 'resources', 'bin')
const version = '0.10.0-test'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assemble(platform: 'darwin' | 'linux' | 'win32') {
  const root = mkdtempSync(join(tmpdir(), `polo-packaged-${platform}-`))
  roots.push(root)
  const resourcesDir = platform === 'darwin'
    ? join(root, 'Polo AI.app', 'Contents', 'Resources')
    : join(root, 'resources')
  const appDir = join(resourcesDir, 'app')
  const binDir = join(appDir, 'resources', 'bin')
  const cliDir = join(appDir, 'dist', 'cli')
  const serverDir = join(appDir, 'dist', 'server')
  const bunDir = join(resourcesDir, 'vendor', 'bun')
  for (const dir of [binDir, cliDir, serverDir, bunDir]) mkdirSync(dir, { recursive: true })

  for (const launcher of ['polo', 'polo-ai', 'polo.cmd', 'polo-ai.cmd']) {
    copyFileSync(join(sourceBin, launcher), join(binDir, launcher))
  }
  const cli = join(cliDir, 'polo-cli.js')
  const cliPackage = join(cliDir, 'package.json')
  const server = join(serverDir, 'polo-server.js')
  writeFileSync(cli, '// assembled CLI payload\n')
  writeFileSync(server, '// assembled server payload\n')
  writeFileSync(cliPackage, `${JSON.stringify({
    name: '@polo-ai/cli',
    version,
    type: 'module',
    main: './polo-cli.js',
    bin: { polo: './polo-cli.js', 'polo-ai': './polo-cli.js' },
  })}\n`)
  writeFileSync(join(cliDir, 'artifact-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    version,
    runtime: 'bun',
    artifacts: {
      cli: { path: 'dist/cli/polo-cli.js', sha256: sha256(cli) },
      cliPackage: { path: 'dist/cli/package.json', sha256: sha256(cliPackage) },
      server: { path: 'dist/server/polo-server.js', sha256: sha256(server) },
    },
  })}\n`)

  const bun = join(bunDir, platform === 'win32' ? 'bun.exe' : 'bun')
  writeFileSync(bun, `#!/bin/sh
printf '%s\\n' "$POLO_AI_SERVER_ENTRY|$POLO_AI_APP_ROOT|$POLO_AI_RESOURCES_PATH|$POLO_AI_BUNDLED_ASSETS_ROOT|$POLO_AI_IS_PACKAGED|$POLO_AI_CLI_JSON_ONLY|$1|$2|$3"
`)
  if (platform !== 'win32') {
    for (const file of [bun, join(binDir, 'polo'), join(binDir, 'polo-ai')]) chmodSync(file, 0o755)
  }
  return { root, resourcesDir, appDir, binDir, cli, server, bun }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('assembled Electron CLI layout', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`contains both aliases and complete payload on ${platform}`, () => {
      const layout = assemble(platform)
      const validated = validatePackagedCliLayout({
        resourcesDir: layout.resourcesDir,
        platform,
        expectedVersion: version,
      })
      expect(validated.appDir).toBe(layout.appDir)
      expect(readFileSync(join(layout.binDir, 'polo-ai'), 'utf8')).toContain('exec "$BIN_DIR/polo" "$@"')
      expect(readFileSync(join(layout.binDir, 'polo-ai.cmd'), 'utf8')).toContain('call "%~dp0polo.cmd" %*')
    })

    it(`rejects a missing assembled server payload on ${platform}`, () => {
      const layout = assemble(platform)
      unlinkSync(layout.server)
      expect(() => validatePackagedCliLayout({
        resourcesDir: layout.resourcesDir,
        platform,
        expectedVersion: version,
      })).toThrow('Packaged CLI payload is missing')
    })
  }

  for (const platform of ['darwin', 'linux'] as const) {
    it(`runs polo and polo-ai through the same self-located payload on ${platform}`, () => {
      const layout = assemble(platform)
      const userBin = join(layout.root, 'user bin')
      mkdirSync(userBin)
      const outputs: string[] = []
      for (const launcher of ['polo', 'polo-ai']) {
        const installed = join(userBin, launcher)
        symlinkSync(join(layout.binDir, launcher), installed)
        const result = Bun.spawnSync([installed, 'probe'], { stdout: 'pipe', stderr: 'pipe' })
        expect(result.exitCode).toBe(0)
        outputs.push(result.stdout.toString().trim())
      }
      expect(outputs[0]).toBe(outputs[1])
      const realAppDir = realpathSync(layout.appDir)
      expect(outputs[0]).toBe([
        join(realAppDir, 'dist', 'server', 'polo-server.js'),
        realAppDir,
        join(realAppDir, 'resources'),
        realAppDir,
        'true',
        '1',
        'run',
        join(realAppDir, 'dist', 'cli', 'polo-cli.js'),
        'probe',
      ].join('|'))
    })
  }

  it('fails the Unix launcher clearly when assembled payload is incomplete', () => {
    const layout = assemble('darwin')
    unlinkSync(layout.server)
    const result = Bun.spawnSync([join(layout.binDir, 'polo'), '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toContain('Polo CLI server payload is missing:')
  })
})
