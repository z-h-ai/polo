import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const installer = readFileSync(join(import.meta.dir, 'install-app.sh'), 'utf8')
const helpers = installer.slice(0, installer.indexOf('# Detect OS'))

function createHome(): string {
  const home = join(tmpdir(), `polo-installer-shell-${crypto.randomUUID()}`)
  roots.push(home)
  mkdirSync(home, { recursive: true })
  return home
}

function configurePath(home: string, shell = '/bin/bash'): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bash', '-c', `${helpers}\nconfigure_managed_path`], {
    env: { ...process.env, HOME: home, SHELL: shell },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux shell PATH setup', () => {
  it('updates an existing .bash_profile instead of an ignored .profile', () => {
    const home = createHome()
    const bashProfile = join(home, '.bash_profile')
    writeFileSync(bashProfile, 'export EDITOR=vim\n')

    const first = configurePath(home)
    const second = configurePath(home)

    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    const content = readFileSync(bashProfile, 'utf8')
    expect(content).toContain('export EDITOR=vim')
    expect(content.match(/# >>> Polo CLI >>>/g)).toHaveLength(1)
    expect(existsSync(join(home, '.profile'))).toBe(false)
  })

  it('honors Bash login-file precedence when .bash_login exists', () => {
    const home = createHome()
    const bashLogin = join(home, '.bash_login')
    writeFileSync(bashLogin, 'export LANG=en_US.UTF-8\n')

    const result = configurePath(home)

    expect(result.exitCode).toBe(0)
    expect(readFileSync(bashLogin, 'utf8')).toContain('# >>> Polo CLI >>>')
    expect(existsSync(join(home, '.profile'))).toBe(false)
  })
})

describe('Linux AppImage installer lifecycle', () => {
  it('installs the packaged canonical wrappers and removes only verified ownership', () => {
    const home = createHome()
    const fakeBin = join(home, 'fake-bin')
    const artifact = join(home, 'Polo-AI-x64.AppImage')
    const binDir = join(home, '.local', 'bin')
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(
      join(fakeBin, 'uname'),
      '#!/bin/sh\ncase "$1" in -m) printf "x86_64\\n" ;; *) printf "Linux\\n" ;; esac\n',
    )
    writeFileSync(join(fakeBin, 'pgrep'), '#!/bin/sh\nexit 1\n')
    writeFileSync(join(fakeBin, 'fusermount'), '#!/bin/sh\nexit 0\n')
    for (const file of ['uname', 'pgrep', 'fusermount']) {
      chmodSync(join(fakeBin, file), 0o755)
    }
    writeFileSync(
      artifact,
      `#!/bin/bash
set -e
[ "\${1:-}" = "--appimage-extract" ] || exit 64
root="$PWD/squashfs-root/resources"
mkdir -p "$root/app/resources/bin" "$root/app/resources/scripts"
mkdir -p "$root/vendor/bun" "$root/app/dist/cli" "$root/app/dist/server"
cp "$POLO_TEST_SOURCE_ROOT/apps/electron/resources/bin/polo" "$root/app/resources/bin/polo"
cp "$POLO_TEST_SOURCE_ROOT/apps/electron/resources/bin/polo-ai" "$root/app/resources/bin/polo-ai"
cp "$POLO_TEST_SOURCE_ROOT/apps/electron/resources/scripts/linux-terminal-integration.sh" "$root/app/resources/scripts/linux-terminal-integration.sh"
chmod +x "$root/app/resources/bin/polo" "$root/app/resources/bin/polo-ai" "$root/app/resources/scripts/linux-terminal-integration.sh"
printf '{\\n  "version": "0.10.0"\\n}\\n' > "$root/app/package.json"
printf '#!/bin/sh\\nprintf "bundled=%%s\\\\n" "$*"\\nexit 19\\n' > "$root/vendor/bun/bun"
chmod +x "$root/vendor/bun/bun"
printf 'cli\\n' > "$root/app/dist/cli/polo-cli.js"
printf 'server\\n' > "$root/app/dist/server/polo-server.js"
`,
    )
    chmodSync(artifact, 0o755)
    const env = {
      ...process.env,
      HOME: home,
      SHELL: '/bin/zsh',
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      POLO_AI_INSTALL_ARTIFACT: artifact,
      POLO_AI_BIN_DIR: binDir,
      POLO_TEST_SOURCE_ROOT: join(import.meta.dir, '..'),
    }

    const installResult = Bun.spawnSync(['bash', join(import.meta.dir, 'install-app.sh')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(installResult.exitCode).toBe(0)
    const installedPolo = join(binDir, 'polo')
    const installedCompat = join(binDir, 'polo-ai')
    expect(lstatSync(installedPolo).isSymbolicLink()).toBe(true)
    expect(lstatSync(installedCompat).isSymbolicLink()).toBe(true)
    expect(readFileSync(installedPolo, 'utf8')).toBe(
      readFileSync(join(import.meta.dir, '..', 'apps', 'electron', 'resources', 'bin', 'polo'), 'utf8'),
    )

    const appResult = Bun.spawnSync([installedPolo, 'app'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(appResult.exitCode).toBe(19)
    expect(appResult.stdout.toString()).toContain('bundled=run')
    expect(appResult.stdout.toString()).toContain('polo-cli.js app')

    const repairResult = Bun.spawnSync(['bash', join(import.meta.dir, 'install-app.sh')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(repairResult.exitCode).toBe(0)
    expect(lstatSync(installedPolo).isSymbolicLink()).toBe(true)

    const statePath = join(home, '.polo-ai', 'terminal-integration-linux.state')
    const profilePath = join(home, '.zprofile')
    const currentPackage = join(home, '.polo-ai', 'app', 'current', 'resources', 'app', 'package.json')
    const appImagePath = join(home, '.polo-ai', 'app', 'Polo-AI-x64.AppImage')
    const originalState = readFileSync(statePath, 'utf8')
    const originalProfile = readFileSync(profilePath, 'utf8')
    const originalPackage = readFileSync(currentPackage, 'utf8')
    const originalAppImage = readFileSync(appImagePath, 'utf8')

    writeFileSync(statePath, 'schemaVersion=3\nowner=attacker\n')
    const corruptUninstall = Bun.spawnSync(
      ['bash', join(import.meta.dir, 'uninstall-app.sh')],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(corruptUninstall.exitCode).toBe(2)
    expect(existsSync(installedPolo)).toBe(true)
    expect(readFileSync(profilePath, 'utf8')).toBe(originalProfile)
    expect(readFileSync(currentPackage, 'utf8')).toBe(originalPackage)
    expect(readFileSync(appImagePath, 'utf8')).toBe(originalAppImage)
    writeFileSync(statePath, originalState)

    const unboundProfile = join(home, '.bash_profile')
    const unboundProfileContent =
      'export USER_SETTING=1\n# >>> Polo CLI >>>\n'
      + 'export PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n'
    writeFileSync(unboundProfile, unboundProfileContent)
    writeFileSync(
      statePath,
      originalState.replace(
        /^profile_path_b64=.*$/m,
        `profile_path_b64=${Buffer.from(unboundProfile).toString('base64')}`,
      ),
    )
    const tamperedProfileUninstall = Bun.spawnSync(
      ['bash', join(import.meta.dir, 'uninstall-app.sh')],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(tamperedProfileUninstall.exitCode).toBe(2)
    expect(readFileSync(unboundProfile, 'utf8')).toBe(unboundProfileContent)
    expect(readFileSync(profilePath, 'utf8')).toBe(originalProfile)
    expect(readFileSync(currentPackage, 'utf8')).toBe(originalPackage)
    expect(readFileSync(appImagePath, 'utf8')).toBe(originalAppImage)
    expect(existsSync(installedPolo)).toBe(true)
    writeFileSync(statePath, originalState)

    writeFileSync(profilePath, `${originalProfile}# >>> Polo CLI >>>\n`)
    const malformedUpgrade = Bun.spawnSync(['bash', join(import.meta.dir, 'install-app.sh')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(malformedUpgrade.exitCode).not.toBe(0)
    expect(readFileSync(currentPackage, 'utf8')).toBe(originalPackage)
    expect(readFileSync(appImagePath, 'utf8')).toBe(originalAppImage)
    expect(readFileSync(statePath, 'utf8')).toBe(originalState)
    expect(lstatSync(installedPolo).isSymbolicLink()).toBe(true)
    writeFileSync(profilePath, originalProfile)

    const lnCount = join(fakeBin, 'ln-count')
    writeFileSync(
      join(fakeBin, 'ln'),
      `#!/bin/bash
set -eu
count=0
[ ! -f "$POLO_TEST_LN_COUNT" ] || count="$(cat "$POLO_TEST_LN_COUNT")"
count=$((count + 1))
printf '%s\\n' "$count" > "$POLO_TEST_LN_COUNT"
if [ "$count" -eq 1 ]; then
  for last; do :; done
  printf 'installer-concurrent-user-file\\n' > "$last"
  exit 73
fi
exec /bin/ln "$@"
`,
    )
    chmodSync(join(fakeBin, 'ln'), 0o755)
    const racedUpgrade = Bun.spawnSync(['bash', join(import.meta.dir, 'install-app.sh')], {
      env: { ...env, POLO_TEST_LN_COUNT: lnCount },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(racedUpgrade.exitCode).not.toBe(0)
    expect(readFileSync(installedPolo, 'utf8')).toContain('installer-concurrent-user-file')
    expect(readFileSync(profilePath, 'utf8')).toBe(originalProfile)
    expect(readFileSync(currentPackage, 'utf8')).toBe(originalPackage)
    expect(readFileSync(appImagePath, 'utf8')).toBe(originalAppImage)
    expect(readFileSync(statePath, 'utf8')).toBe(originalState)
    const quarantineDirs = readdirSync(join(home, '.polo-ai'))
      .filter((name) => name.startsWith('.terminal-install.'))
    expect(quarantineDirs).toHaveLength(1)
    const quarantine = join(home, '.polo-ai', quarantineDirs[0]!)
    expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
      'reason=concurrent-path-occupation',
    )
    expect(racedUpgrade.stderr.toString()).toContain(quarantine)

    rmSync(installedPolo)
    renameSync(join(quarantine, 'polo.previous'), installedPolo)
    rmSync(quarantine, { recursive: true, force: true })
    rmSync(join(fakeBin, 'ln'))

    const userProfile = join(home, '.bash_profile')
    const userProfileContent =
      'export USER_SETTING=1\n# >>> Polo CLI >>>\n'
      + 'export PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n'
    writeFileSync(userProfile, userProfileContent)
    const uninstallResult = Bun.spawnSync(
      ['bash', join(import.meta.dir, 'uninstall-app.sh')],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(uninstallResult.exitCode).toBe(0)
    expect(existsSync(installedPolo)).toBe(false)
    expect(existsSync(installedCompat)).toBe(false)
    expect(existsSync(join(home, '.polo-ai', 'app'))).toBe(false)
    expect(readFileSync(userProfile, 'utf8')).toBe(userProfileContent)
  }, 20_000)
})
