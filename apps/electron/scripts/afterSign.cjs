const path = require('path');
const { spawnSync } = require('child_process');

function runStapler(command, args, run = spawnSync) {
  const result = run(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20 * 60_000,
  });
  return { ok: !result.error && result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}` };
}

// The auto-update ZIP must carry a stapled notarization ticket on its inner
// App (POO-14 signing contract, `stapler validate` on the extracted bundle).
// electron-builder's built-in notarization staples opportunistically and has
// been observed skipping the staple on the Intel x64 runner (arm64 releases
// validate while x64 fails with "ZIP does not contain a valid stapled
// ticket", v0.18.5-v0.19.0). Stapling here runs after notarization and
// BEFORE the zip/dmg targets are built, so every target embeds the ticket,
// and a failed staple fails the build loudly instead of silently.
function stapleAppBundle(context, { run = spawnSync } = {}) {
  const appOutDir = context.appOutDir;
  const packager = context.packager || {};
  const appName = (packager.appInfo && packager.appInfo.productFilename) || 'app';
  const appBundle = path.join(appOutDir, `${appName}.app`);

  // Already stapled (e.g. by @electron/notarize) — keep the existing ticket.
  const validated = runStapler('xcrun', ['stapler', 'validate', appBundle], run);
  if (validated.ok) {
    console.log(`macOS App already stapled: ${path.basename(appBundle)}`);
    return appBundle;
  }

  const stapled = runStapler('xcrun', ['stapler', 'staple', appBundle], run);
  if (!stapled.ok) {
    throw new Error(`macOS App stapling failed for ${path.basename(appBundle)}: ${stapled.output.trim()}`);
  }
  console.log(`Stapled macOS App before target build: ${path.basename(appBundle)}`);
  return appBundle;
}

function afterSign(context) {
  if (process.platform !== 'darwin') return;
  const mode = process.env.POLO_AI_ARTIFACT_VALIDATION_MODE || 'smoke';
  // Development smoke builds are ad-hoc signed with notarization disabled
  // (see scripts/electron-dist.ts); there is no ticket to staple for them.
  if (mode === 'smoke') return;
  stapleAppBundle(context);
}

afterSign.stapleAppBundle = stapleAppBundle;

module.exports = afterSign;
