const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

module.exports = async function beforePack(context) {
  const appDir = context.packager.projectDir
  const cli = join(appDir, 'dist', 'cli', 'polo-cli.js')
  const server = join(appDir, 'dist', 'server', 'polo-server.js')
  const manifestPath = join(appDir, 'dist', 'cli', 'artifact-manifest.json')
  const wrapper = join(appDir, 'resources', 'bin', context.electronPlatformName === 'win32' ? 'polo.cmd' : 'polo')
  const bun = join(appDir, 'vendor', 'bun', context.electronPlatformName === 'win32' ? 'bun.exe' : 'bun')

  for (const path of [cli, server, manifestPath, wrapper, bun]) {
    if (!existsSync(path)) {
      throw new Error(`POO-14 packaged CLI validation failed; missing: ${path}`)
    }
  }

  const appVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== appVersion) {
    throw new Error(`POO-14 CLI/App version mismatch: CLI ${manifest.version}, App ${appVersion}`)
  }

  const versionCheck = spawnSync(bun, ['run', cli, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (versionCheck.status !== 0 || versionCheck.stdout.trim() !== appVersion) {
    throw new Error(
      `POO-14 packaged CLI execution failed: ${versionCheck.stderr || versionCheck.stdout}`,
    )
  }
}
