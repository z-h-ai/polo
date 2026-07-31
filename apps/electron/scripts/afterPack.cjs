/**
 * electron-builder afterPack hook
 *
 * Copies the pre-compiled macOS 26+ Liquid Glass icon (Assets.car) into the
 * app bundle. The Assets.car file is compiled locally using actool with the
 * macOS 26 SDK (not available in CI), then committed to the repo.
 *
 * To regenerate Assets.car after icon changes:
 *   cd apps/electron
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 *
 * For older macOS versions, the app falls back to icon.icns which is
 * included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');

function validatePackagedCli(context) {
  const isMac = context.electronPlatformName === 'darwin';
  const isWindows = context.electronPlatformName === 'win32';
  const resourcesDir = isMac
    ? path.join(context.appOutDir, 'Polo AI.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const appDir = path.join(resourcesDir, 'app');
  const cli = path.join(appDir, 'dist', 'cli', 'polo-cli.js');
  const server = path.join(appDir, 'dist', 'server', 'polo-server.js');
  const manifestPath = path.join(appDir, 'dist', 'cli', 'artifact-manifest.json');
  const cliPackagePath = path.join(appDir, 'dist', 'cli', 'package.json');
  const wrapper = path.join(appDir, 'resources', 'bin', isWindows ? 'polo.cmd' : 'polo');
  const wrapperMessages = path.join(
    appDir,
    'resources',
    'bin',
    isWindows ? 'polo-messages.cmd' : 'polo-messages.sh',
  );
  const windowsInstallerScript = path.join(
    appDir,
    'resources',
    'scripts',
    'windows-terminal-integration.ps1',
  );
  const linuxInstallerScript = path.join(
    appDir,
    'resources',
    'scripts',
    'linux-terminal-integration.sh',
  );
  const atomicRenameHelper = path.join(
    appDir,
    'resources',
    'scripts',
    'atomic-rename-no-replace.ts',
  );
  const bun = path.join(resourcesDir, 'vendor', 'bun', isWindows ? 'bun.exe' : 'bun');
  const archNames = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  const expectedArch = archNames[context.arch];
  const platformKey = `${context.electronPlatformName}-${expectedArch}`;
  const uv = path.join(
    appDir,
    'resources',
    'bin',
    platformKey,
    isWindows ? 'uv.exe' : 'uv',
  );
  const uvManifestPath = path.join(
    appDir,
    'resources',
    'bin',
    platformKey,
    'runtime-manifest.json',
  );
  const uvLockPath = path.join(context.packager.projectDir, '..', '..', 'scripts', 'uv-runtime-lock.json');

  const requiredArtifacts = [
    cli,
    server,
    manifestPath,
    cliPackagePath,
    wrapper,
    wrapperMessages,
    bun,
    uv,
    uvManifestPath,
    uvLockPath,
  ];
  if (isWindows) requiredArtifacts.push(windowsInstallerScript);
  if (context.electronPlatformName === 'linux') {
    requiredArtifacts.push(linuxInstallerScript, atomicRenameHelper);
  }
  for (const required of requiredArtifacts) {
    if (!fs.existsSync(required)) {
      throw new Error(`POO-14 unpacked CLI validation failed; missing: ${required}`);
    }
  }

  const appVersion = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== appVersion) {
    throw new Error(`POO-14 unpacked CLI/App version mismatch: ${manifest.version} vs ${appVersion}`);
  }
  const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (
    manifest.artifacts?.cli?.sha256 !== sha256(cli)
    || manifest.artifacts?.cliPackage?.sha256 !== sha256(cliPackagePath)
    || manifest.artifacts?.server?.sha256 !== sha256(server)
  ) {
    throw new Error('POO-14 unpacked CLI metadata/server checksums do not match the artifact manifest');
  }
  if (
    manifest.artifacts?.cliPackage?.path !== 'dist/cli/package.json'
    || manifest.artifacts?.cli?.path !== 'dist/cli/polo-cli.js'
    || manifest.artifacts?.server?.path !== 'dist/server/polo-server.js'
  ) {
    throw new Error('POO-14 unpacked artifact manifest contains unexpected paths');
  }
  const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, 'utf8'));
  const allowedPackageKeys = ['name', 'version', 'type', 'main', 'bin', 'license'];
  if (
    cliPackage.name !== '@polo-ai/cli'
    || cliPackage.version !== appVersion
    || cliPackage.type !== 'module'
    || cliPackage.main !== './polo-cli.js'
    || cliPackage.bin?.polo !== './polo-cli.js'
    || cliPackage.bin?.['polo-ai'] !== './polo-cli.js'
    || cliPackage.license !== 'Apache-2.0'
    || Object.keys(cliPackage).some((key) => !allowedPackageKeys.includes(key))
  ) {
    throw new Error('POO-14 unpacked sanitized CLI package metadata is invalid');
  }

  const uvManifest = JSON.parse(fs.readFileSync(uvManifestPath, 'utf8'));
  const uvLock = JSON.parse(fs.readFileSync(uvLockPath, 'utf8'));
  const uvTarget = uvLock.targets?.[platformKey];
  if (
    !uvTarget
    || uvManifest.schemaVersion !== 1
    || uvManifest.platform !== context.electronPlatformName
    || uvManifest.arch !== expectedArch
    || uvManifest.source !== 'astral-sh-release'
    || uvManifest.version !== uvLock.version
    || uvManifest.binary !== (isWindows ? 'uv.exe' : 'uv')
    || uvManifest.sha256 !== uvTarget.binarySha256
    || uvManifest.sha256 !== sha256(uv)
    || uvManifest.releaseAsset !== uvTarget.asset
    || uvManifest.releaseAssetSha256 !== uvTarget.archiveSha256
  ) {
    throw new Error(`POO-14 unpacked target uv runtime validation failed for ${platformKey}`);
  }

  const runtimeArch = spawnSync(bun, ['-e', 'process.stdout.write(process.arch)'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (
    runtimeArch.status !== 0
    || (expectedArch && expectedArch !== 'universal' && runtimeArch.stdout.trim() !== expectedArch)
  ) {
    throw new Error(
      `POO-14 bundled runtime architecture mismatch: expected ${expectedArch}, `
      + `got ${runtimeArch.stdout.trim() || runtimeArch.stderr}`,
    );
  }

  const directCheck = spawnSync(bun, ['run', cli, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (directCheck.status !== 0 || directCheck.stdout.trim() !== appVersion) {
    throw new Error(
      `POO-14 unpacked CLI execution failed: ${directCheck.stderr || directCheck.stdout}`,
    );
  }

  const uvVersionCheck = spawnSync(uv, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const uvVersionPattern = new RegExp(
    `^uv ${uvLock.version.replaceAll('.', '\\.')}(?: \\([^()\\r\\n]+\\))?$`,
  );
  if (
    uvVersionCheck.status !== 0
    || !uvVersionPattern.test(uvVersionCheck.stdout.trim())
  ) {
    throw new Error(
      `POO-14 unpacked uv execution failed: ${uvVersionCheck.stderr || uvVersionCheck.stdout}`,
    );
  }

  // Windows users execute the launcher generated by the NSIS integration
  // script, not the source-tree wrapper. Validate that exact generation path
  // against the unpacked app before installer creation.
  const launcherCheck = isWindows
    ? spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          windowsInstallerScript,
          '-Mode',
          'Validate',
          '-InstallDir',
          context.appOutDir,
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      )
    : spawnSync(wrapper, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (
    launcherCheck.status !== 0
    || (!isWindows && launcherCheck.stdout.trim() !== appVersion)
  ) {
    throw new Error(
      `POO-14 unpacked installer launcher execution failed: `
      + `${launcherCheck.stderr || launcherCheck.stdout}`,
    );
  }

  console.log(`Packaged Polo terminal artifacts validated (${appVersion})`);
}

module.exports = async function afterPack(context) {
  validatePackagedCli(context);

  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const resourcesDir = path.join(appPath, 'Polo AI.app', 'Contents', 'Resources');
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  console.log(`afterPack: looking for Assets.car at ${precompiledAssets}`);

  // Check if pre-compiled Assets.car exists
  if (!fs.existsSync(precompiledAssets)) {
    console.log('Warning: Pre-compiled Assets.car not found in resources/');
    console.log('The app will use the fallback icon.icns on all macOS versions');
    return;
  }

  // Copy pre-compiled Assets.car to the app bundle
  const destAssetsCar = path.join(resourcesDir, 'Assets.car');
  try {
    fs.copyFileSync(precompiledAssets, destAssetsCar);
    console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
  } catch (err) {
    // Don't fail the build if Assets.car can't be copied - app will use fallback icon.icns
    console.log(`Warning: Could not copy Assets.car: ${err.message}`);
    console.log('The app will use the fallback icon.icns on all macOS versions');
  }
};
