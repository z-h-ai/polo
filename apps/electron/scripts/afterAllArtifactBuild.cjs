const path = require('path');
const { spawnSync } = require('child_process');

function requireMacNotaryCredentials(env) {
  const credentials = {
    appleId: env.APPLE_ID?.trim(),
    password: env.APPLE_APP_SPECIFIC_PASSWORD?.trim(),
    teamId: env.APPLE_TEAM_ID?.trim(),
  };
  const missing = Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(', ');
  if (missing) {
    throw new Error(`macOS DMG notarization requires ${missing}`);
  }
  return credentials;
}

function runMacNotaryCommand(command, args, run) {
  const result = run(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 20 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `macOS DMG notarization command failed: ${result.error?.message || `exit ${result.status}`}`,
    );
  }
}

function notarizeMacDmgArtifacts(artifactPaths, { env = process.env, run = spawnSync } = {}) {
  const dmgPaths = artifactPaths.filter((artifact) => path.extname(artifact).toLowerCase() === '.dmg');
  if (dmgPaths.length === 0) {
    throw new Error('macOS release did not produce a DMG to notarize');
  }
  const { appleId, password, teamId } = requireMacNotaryCredentials(env);
  for (const dmgPath of dmgPaths) {
    // electron-builder notarizes the enclosed App before it builds the DMG.
    // The release contract also requires an independently notarized/stapled
    // outer installer, which must happen after the DMG exists.
    runMacNotaryCommand(
      'xcrun',
      ['notarytool', 'submit', dmgPath, '--apple-id', appleId, '--password', password, '--team-id', teamId, '--wait'],
      run,
    );
    runMacNotaryCommand('xcrun', ['stapler', 'staple', dmgPath], run);
    console.log(`Notarized and stapled outer macOS DMG: ${path.basename(dmgPath)}`);
  }
}

async function afterAllArtifactBuild(context) {
  const artifactPaths = context.artifactPaths || [];
  const releaseDir = context.outDir
    || (artifactPaths[0] ? path.dirname(artifactPaths[0]) : path.join(__dirname, '..', 'release'));
  const joinedNames = artifactPaths.map((artifact) => path.basename(artifact)).join('\n');
  const arch = /(?:^|[-_])arm64(?:[.-]|$)|aarch64/i.test(joinedNames) ? 'arm64' : 'x64';
  const mode = process.env.POLO_AI_ARTIFACT_VALIDATION_MODE || 'smoke';
  const previousArtifact = process.env.POLO_AI_PREVIOUS_ARTIFACT;
  if (mode === 'full' && !previousArtifact) {
    throw new Error(
      'POO-14 full artifact validation requires POLO_AI_PREVIOUS_ARTIFACT',
    );
  }

  // Development smoke builds deliberately disable notarization. Production
  // release modes must finalize the outer DMG before its release audit runs.
  if (process.platform === 'darwin' && mode !== 'smoke') {
    notarizeMacDmgArtifacts(artifactPaths);
  }

  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'validate-final-artifacts.ps1'),
      '-Mode',
      mode === 'full' ? 'Full' : mode === 'bootstrap' ? 'Bootstrap' : 'Smoke',
      '-ReleaseDir',
      releaseDir,
      '-Arch',
      arch,
      ...(previousArtifact ? ['-PreviousArtifact', previousArtifact] : []),
    ];
  } else {
    command = 'bash';
    args = [
      path.join(__dirname, 'validate-final-artifacts.sh'),
      '--mode',
      mode,
      '--release-dir',
      releaseDir,
      '--arch',
      arch,
      ...(previousArtifact ? ['--previous-artifact', previousArtifact] : []),
    ];
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: mode === 'full' || mode === 'bootstrap' || mode === 'signing' ? 15 * 60_000 : 5 * 60_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `POO-14 final artifact validation failed (${process.platform}/${arch}/${mode}): `
      + `${result.error?.message || `exit ${result.status}`}`,
    );
  }
  return [];
}

afterAllArtifactBuild.notarizeMacDmgArtifacts = notarizeMacDmgArtifacts;
afterAllArtifactBuild.requireMacNotaryCredentials = requireMacNotaryCredentials;

module.exports = afterAllArtifactBuild;
