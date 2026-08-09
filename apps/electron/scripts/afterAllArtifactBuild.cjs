const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async function afterAllArtifactBuild(context) {
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
};
