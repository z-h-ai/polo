import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const root = join(import.meta.dir, '..')
const electronDir = join(root, 'apps', 'electron')
const require = createRequire(import.meta.url)
const { validateLauncherSources } = require(
  join(electronDir, 'scripts', 'packaged-cli-layout.cjs'),
) as { validateLauncherSources(binDir: string): void }

validateLauncherSources(join(electronDir, 'resources', 'bin'))

const cli = join(electronDir, 'dist', 'cli', 'polo-cli.js')
const server = join(electronDir, 'dist', 'server', 'polo-server.js')
const manifest = join(electronDir, 'dist', 'cli', 'artifact-manifest.json')
for (const path of [cli, server, manifest]) {
  if (!existsSync(path)) throw new Error(`Required packaged artifact is missing: ${path}`)
}

const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
const check = Bun.spawnSync([process.execPath, 'run', cli, '--version'], {
  stdout: 'pipe',
  stderr: 'pipe',
})
if (check.exitCode !== 0 || check.stdout.toString().trim() !== expectedVersion) {
  throw new Error(`Packaged CLI --version failed: ${check.stderr.toString() || check.stdout.toString()}`)
}

console.log(`Packaged CLI artifacts validated (${expectedVersion})`)
