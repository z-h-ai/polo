const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')

function packagedResourcesDir(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, 'Polo AI.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function validateLauncherSources(binDir) {
  const launchers = {
    polo: path.join(binDir, 'polo'),
    poloAi: path.join(binDir, 'polo-ai'),
    poloCmd: path.join(binDir, 'polo.cmd'),
    poloAiCmd: path.join(binDir, 'polo-ai.cmd'),
  }
  for (const [name, file] of Object.entries(launchers)) {
    if (!existsSync(file)) throw new Error(`Packaged ${name} launcher is missing: ${file}`)
  }

  const unixPrimary = readFileSync(launchers.polo, 'utf8')
  const unixAlias = readFileSync(launchers.poloAi, 'utf8')
  const windowsPrimary = readFileSync(launchers.poloCmd, 'utf8')
  const windowsAlias = readFileSync(launchers.poloAiCmd, 'utf8')
  for (const required of ['vendor/bun/bun', 'dist/cli/polo-cli.js', 'dist/server/polo-server.js']) {
    if (!unixPrimary.includes(required)) {
      throw new Error(`Unix polo launcher does not self-locate ${required}`)
    }
  }
  for (const required of ['vendor\\bun\\bun.exe', 'dist\\cli\\polo-cli.js', 'dist\\server\\polo-server.js']) {
    if (!windowsPrimary.includes(required)) {
      throw new Error(`Windows polo launcher does not self-locate ${required}`)
    }
  }
  if (!unixAlias.includes('exec "$BIN_DIR/polo" "$@"')) {
    throw new Error('Unix polo-ai launcher must dispatch to the primary polo implementation')
  }
  if (!windowsAlias.includes('call "%~dp0polo.cmd" %*')) {
    throw new Error('Windows polo-ai launcher must dispatch to the primary polo implementation')
  }
  return launchers
}

function validatePayload(appDir, expectedVersion) {
  const cli = path.join(appDir, 'dist', 'cli', 'polo-cli.js')
  const cliPackagePath = path.join(appDir, 'dist', 'cli', 'package.json')
  const server = path.join(appDir, 'dist', 'server', 'polo-server.js')
  const manifestPath = path.join(appDir, 'dist', 'cli', 'artifact-manifest.json')
  for (const required of [cli, cliPackagePath, server, manifestPath]) {
    if (!existsSync(required)) throw new Error(`Packaged CLI payload is missing: ${required}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`Packaged CLI/App version mismatch: ${manifest.version} vs ${expectedVersion}`)
  }
  const expectedArtifacts = {
    cli: ['dist/cli/polo-cli.js', cli],
    cliPackage: ['dist/cli/package.json', cliPackagePath],
    server: ['dist/server/polo-server.js', server],
  }
  for (const [name, [relativePath, file]] of Object.entries(expectedArtifacts)) {
    const artifact = manifest.artifacts?.[name]
    if (artifact?.path !== relativePath || artifact?.sha256 !== sha256(file)) {
      throw new Error(`Packaged ${name} artifact does not match its manifest`)
    }
  }

  const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8'))
  if (
    cliPackage.bin?.polo !== './polo-cli.js'
    || cliPackage.bin?.['polo-ai'] !== './polo-cli.js'
  ) {
    throw new Error('Packaged CLI metadata must map polo and polo-ai to the same implementation')
  }
  return { cli, server, manifestPath }
}

function validatePackagedCliLayout({ resourcesDir, platform, expectedVersion }) {
  const appDir = path.join(resourcesDir, 'app')
  const binDir = path.join(appDir, 'resources', 'bin')
  const launchers = validateLauncherSources(binDir)
  const payload = validatePayload(appDir, expectedVersion)
  const bun = path.join(resourcesDir, 'vendor', 'bun', platform === 'win32' ? 'bun.exe' : 'bun')
  if (!existsSync(bun)) throw new Error(`Packaged Bun runtime is missing: ${bun}`)
  return { resourcesDir, appDir, binDir, bun, ...launchers, ...payload }
}

function validateSourceCliLayout(projectDir, platform) {
  const appVersion = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version
  validateLauncherSources(path.join(projectDir, 'resources', 'bin'))
  validatePayload(projectDir, appVersion)
  const bun = path.join(projectDir, 'vendor', 'bun', platform === 'win32' ? 'bun.exe' : 'bun')
  if (!existsSync(bun)) throw new Error(`Bundled Bun runtime is missing before packaging: ${bun}`)
}

module.exports = {
  packagedResourcesDir,
  validateLauncherSources,
  validatePackagedCliLayout,
  validateSourceCliLayout,
}
