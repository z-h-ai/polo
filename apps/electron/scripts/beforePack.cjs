const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { validateSourceCliLayout } = require('./packaged-cli-layout.cjs')

module.exports = async function beforePack(context) {
  const appDir = context.packager.projectDir
  const archNames = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
  const arch = archNames[context.arch]
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`POO-14 unsupported Electron target architecture: ${arch || context.arch}`)
  }
  validateSourceCliLayout(appDir, context.electronPlatformName)
  const platformKey = `${context.electronPlatformName}-${arch}`
  const cli = join(appDir, 'dist', 'cli', 'polo-cli.js')
  const server = join(appDir, 'dist', 'server', 'polo-server.js')
  const manifestPath = join(appDir, 'dist', 'cli', 'artifact-manifest.json')
  const wrapper = join(appDir, 'resources', 'bin', context.electronPlatformName === 'win32' ? 'polo.cmd' : 'polo')
  const bun = join(appDir, 'vendor', 'bun', context.electronPlatformName === 'win32' ? 'bun.exe' : 'bun')
  const uv = join(
    appDir,
    'resources',
    'bin',
    platformKey,
    context.electronPlatformName === 'win32' ? 'uv.exe' : 'uv',
  )
  const uvManifestPath = join(appDir, 'resources', 'bin', platformKey, 'runtime-manifest.json')
  const uvLockPath = join(appDir, '..', '..', 'scripts', 'uv-runtime-lock.json')

  for (const path of [cli, server, manifestPath, wrapper, bun, uv, uvManifestPath, uvLockPath]) {
    if (!existsSync(path)) {
      throw new Error(`POO-14 packaged CLI validation failed; missing: ${path}`)
    }
  }

  const appVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== appVersion) {
    throw new Error(`POO-14 CLI/App version mismatch: CLI ${manifest.version}, App ${appVersion}`)
  }
  const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const uvManifest = JSON.parse(readFileSync(uvManifestPath, 'utf8'))
  const uvLock = JSON.parse(readFileSync(uvLockPath, 'utf8'))
  const uvTarget = uvLock.targets?.[platformKey]
  if (
    !uvTarget
    || uvManifest.schemaVersion !== 1
    || uvManifest.platform !== context.electronPlatformName
    || uvManifest.arch !== arch
    || uvManifest.source !== 'astral-sh-release'
    || uvManifest.version !== uvLock.version
    || uvManifest.binary !== (context.electronPlatformName === 'win32' ? 'uv.exe' : 'uv')
    || uvManifest.sha256 !== uvTarget.binarySha256
    || uvManifest.sha256 !== sha256(uv)
    || uvManifest.releaseAsset !== uvTarget.asset
    || uvManifest.releaseAssetSha256 !== uvTarget.archiveSha256
  ) {
    throw new Error(`POO-14 target uv runtime validation failed for ${platformKey}`)
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
