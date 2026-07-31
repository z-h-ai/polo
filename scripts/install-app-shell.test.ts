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
  return Bun.spawnSync(['bash', '-c', `${helpers}
APP_DIR="$HOME/.polo-ai/app"
MANAGED_PROFILE_PATH="$(managed_profile_path)"
begin_managed_profile_transaction "$APP_DIR"
configure_managed_path
rm -rf "$profile_transaction_dir"
`], {
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

  it('rejects regular, symlink, rename, and content races while claiming profile configuration', () => {
    for (const mode of ['regular', 'symlink', 'rename', 'content'] as const) {
      const home = createHome()
      const appDir = join(home, '.polo-ai', 'app')
      const profilePath = join(home, '.bash_profile')
      const fakeBin = join(home, `profile-config-race-${mode}`)
      const userTarget = join(fakeBin, 'user-profile-target')
      mkdirSync(fakeBin, { recursive: true })
      writeFileSync(profilePath, 'export EDITOR=vim\n')
      writeFileSync(userTarget, `concurrent-profile-${mode}\n`)
      writeFileSync(
        join(fakeBin, 'mv'),
        `#!/bin/bash
set -eu
src="$1"
dest="$2"
if [ "$src" = "$POLO_TEST_PROFILE_PATH" ] && [[ "$dest" == */profile.claimed ]]; then
  case "$POLO_TEST_PROFILE_RACE" in
    regular) printf 'concurrent-profile-regular\\n' > "$src" ;;
    symlink)
      rm -f "$src"
      /bin/ln -s "$POLO_TEST_PROFILE_USER_TARGET" "$src"
      ;;
    rename)
      /bin/mv "$src" "$src.concurrent-renamed"
      printf 'concurrent-profile-rename\\n' > "$src"
      ;;
    content) printf 'concurrent-profile-content\\n' >> "$src" ;;
  esac
fi
exec /bin/mv "$@"
`,
      )
      chmodSync(join(fakeBin, 'mv'), 0o755)
      const result = Bun.spawnSync(
        ['bash', '-c', `${helpers}
APP_DIR="$HOME/.polo-ai/app"
MANAGED_PROFILE_PATH="$HOME/.bash_profile"
begin_managed_profile_transaction "$APP_DIR"
PATH="$POLO_TEST_FAKE_BIN:$PATH"
configure_managed_path
`],
        {
          env: {
            ...process.env,
            HOME: home,
            SHELL: '/bin/bash',
            POLO_TEST_FAKE_BIN: fakeBin,
            POLO_TEST_PROFILE_PATH: profilePath,
            POLO_TEST_PROFILE_RACE: mode,
            POLO_TEST_PROFILE_USER_TARGET: userTarget,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )

      expect(result.exitCode).not.toBe(0)
      if (mode === 'symlink') {
        expect(lstatSync(profilePath).isSymbolicLink()).toBe(true)
      }
      expect(readFileSync(profilePath, 'utf8')).toContain(`concurrent-profile-${mode}`)
      const quarantineDirs = readdirSync(appDir)
        .filter((name) => name.startsWith('.profile-transaction.'))
      expect(quarantineDirs).toHaveLength(1)
      const quarantine = join(appDir, quarantineDirs[0]!)
      expect(readFileSync(join(quarantine, 'profile.previous'), 'utf8')).toBe(
        'export EDITOR=vim\n',
      )
      expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
        'reason=profile-config-claim-identity-mismatch',
      )
    }
  })

  it('detects a profile update made while the verified backup is copied', () => {
    const home = createHome()
    const appDir = join(home, '.polo-ai', 'app')
    const profilePath = join(home, '.bash_profile')
    const fakeBin = join(home, 'profile-backup-race')
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(profilePath, 'export EDITOR=vim\n')
    writeFileSync(
      join(fakeBin, 'cp'),
      `#!/bin/bash
set -eu
src="\${@: -2:1}"
/bin/cp "$@"
if [ "$src" = "$POLO_TEST_PROFILE_PATH" ]; then
  printf 'backup-concurrent-update\\n' >> "$src"
fi
`,
    )
    chmodSync(join(fakeBin, 'cp'), 0o755)

    const result = Bun.spawnSync(
      ['bash', '-c', `${helpers}
APP_DIR="$HOME/.polo-ai/app"
MANAGED_PROFILE_PATH="$HOME/.bash_profile"
PATH="$POLO_TEST_FAKE_BIN:$PATH"
begin_managed_profile_transaction "$APP_DIR"
`],
      {
        env: {
          ...process.env,
          HOME: home,
          SHELL: '/bin/bash',
          POLO_TEST_FAKE_BIN: fakeBin,
          POLO_TEST_PROFILE_PATH: profilePath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(profilePath, 'utf8')).toContain('backup-concurrent-update')
    const quarantineDirs = readdirSync(appDir)
      .filter((name) => name.startsWith('.profile-transaction.'))
    expect(quarantineDirs).toHaveLength(1)
    expect(
      readFileSync(join(appDir, quarantineDirs[0]!, 'ROLLBACK_REQUIRED'), 'utf8'),
    ).toContain('reason=profile-backup-snapshot-changed')
  })

  it('publishes profile configuration with no-replace when a regular file or symlink appears', () => {
    for (const mode of ['regular', 'symlink'] as const) {
      const home = createHome()
      const appDir = join(home, '.polo-ai', 'app')
      const profilePath = join(home, '.bash_profile')
      const fakeBin = join(home, `profile-publish-race-${mode}`)
      const userTarget = join(fakeBin, 'user-profile-target')
      const injected = join(fakeBin, 'injected')
      mkdirSync(fakeBin, { recursive: true })
      writeFileSync(profilePath, 'export EDITOR=vim\n')
      writeFileSync(userTarget, `publish-concurrent-${mode}\n`)
      writeFileSync(
        join(fakeBin, 'ln'),
        `#!/bin/bash
set -eu
for last; do :; done
if [ "$last" = "$POLO_TEST_PROFILE_PATH" ] && [ ! -e "$POLO_TEST_INJECTED" ]; then
  : > "$POLO_TEST_INJECTED"
  case "$POLO_TEST_PROFILE_RACE" in
    regular) printf 'publish-concurrent-regular\\n' > "$last" ;;
    symlink) /bin/ln -s "$POLO_TEST_PROFILE_USER_TARGET" "$last" ;;
  esac
  exit 73
fi
exec /bin/ln "$@"
`,
      )
      chmodSync(join(fakeBin, 'ln'), 0o755)

      const result = Bun.spawnSync(
        ['bash', '-c', `${helpers}
APP_DIR="$HOME/.polo-ai/app"
MANAGED_PROFILE_PATH="$HOME/.bash_profile"
begin_managed_profile_transaction "$APP_DIR"
PATH="$POLO_TEST_FAKE_BIN:$PATH"
configure_managed_path
`],
        {
          env: {
            ...process.env,
            HOME: home,
            SHELL: '/bin/bash',
            POLO_TEST_FAKE_BIN: fakeBin,
            POLO_TEST_PROFILE_PATH: profilePath,
            POLO_TEST_PROFILE_RACE: mode,
            POLO_TEST_PROFILE_USER_TARGET: userTarget,
            POLO_TEST_INJECTED: injected,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )

      expect(result.exitCode).not.toBe(0)
      if (mode === 'symlink') {
        expect(lstatSync(profilePath).isSymbolicLink()).toBe(true)
      }
      expect(readFileSync(profilePath, 'utf8')).toContain(`publish-concurrent-${mode}`)
      const quarantineDirs = readdirSync(appDir)
        .filter((name) => name.startsWith('.profile-transaction.'))
      expect(quarantineDirs).toHaveLength(1)
      const quarantine = join(appDir, quarantineDirs[0]!)
      expect(readFileSync(join(quarantine, 'profile.previous'), 'utf8')).toBe(
        'export EDITOR=vim\n',
      )
      expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
        'reason=profile-config-path-occupied',
      )
    }
  })

  it('never overwrites regular, symlink, rename, or content updates during profile rollback', () => {
    for (const mode of ['regular', 'symlink', 'rename', 'content'] as const) {
      const home = createHome()
      const appDir = join(home, '.polo-ai', 'app')
      const profilePath = join(home, '.bash_profile')
      const userTarget = join(home, `rollback-user-target-${mode}`)
      writeFileSync(profilePath, 'export EDITOR=vim\n')
      writeFileSync(userTarget, `rollback-concurrent-${mode}\n`)
      const result = Bun.spawnSync(
        ['bash', '-c', `${helpers}
APP_DIR="$HOME/.polo-ai/app"
MANAGED_PROFILE_PATH="$HOME/.bash_profile"
begin_managed_profile_transaction "$APP_DIR"
configure_managed_path
case "$POLO_TEST_PROFILE_RACE" in
  regular) printf 'rollback-concurrent-regular\\n' > "$MANAGED_PROFILE_PATH" ;;
  symlink)
    rm -f "$MANAGED_PROFILE_PATH"
    /bin/ln -s "$POLO_TEST_PROFILE_USER_TARGET" "$MANAGED_PROFILE_PATH"
    ;;
  rename)
    /bin/mv "$MANAGED_PROFILE_PATH" "$MANAGED_PROFILE_PATH.concurrent-renamed"
    printf 'rollback-concurrent-rename\\n' > "$MANAGED_PROFILE_PATH"
    ;;
  content) printf 'rollback-concurrent-content\\n' >> "$MANAGED_PROFILE_PATH" ;;
esac
restore_managed_profile "$MANAGED_PROFILE_PATH" "$profile_backup" "$profile_existed"
`],
        {
          env: {
            ...process.env,
            HOME: home,
            SHELL: '/bin/bash',
            POLO_TEST_PROFILE_RACE: mode,
            POLO_TEST_PROFILE_USER_TARGET: userTarget,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )

      expect(result.exitCode).not.toBe(0)
      if (mode === 'symlink') {
        expect(lstatSync(profilePath).isSymbolicLink()).toBe(true)
      }
      expect(readFileSync(profilePath, 'utf8')).toContain(`rollback-concurrent-${mode}`)
      const quarantineDirs = readdirSync(appDir)
        .filter((name) => name.startsWith('.profile-transaction.'))
      expect(quarantineDirs).toHaveLength(1)
      const quarantine = join(appDir, quarantineDirs[0]!)
      expect(readFileSync(join(quarantine, 'profile.previous'), 'utf8')).toBe(
        'export EDITOR=vim\n',
      )
      expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
        'reason=profile-rollback-claim-identity-mismatch',
      )
    }
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
  printf 'concurrent-profile-update\\n' > "$POLO_TEST_PROFILE_PATH"
  printf 'installer-concurrent-user-file\\n' > "$last"
  exit 73
fi
exec /bin/ln "$@"
`,
    )
    chmodSync(join(fakeBin, 'ln'), 0o755)
    const racedUpgrade = Bun.spawnSync(['bash', join(import.meta.dir, 'install-app.sh')], {
      env: { ...env, POLO_TEST_LN_COUNT: lnCount, POLO_TEST_PROFILE_PATH: profilePath },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(racedUpgrade.exitCode).not.toBe(0)
    expect(readFileSync(installedPolo, 'utf8')).toContain('installer-concurrent-user-file')
    expect(readFileSync(profilePath, 'utf8')).toBe('concurrent-profile-update\n')
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
    const profileQuarantineDirs = readdirSync(join(home, '.polo-ai', 'app'))
      .filter((name) => name.startsWith('.profile-transaction.'))
    expect(profileQuarantineDirs).toHaveLength(1)
    const profileQuarantine = join(
      home,
      '.polo-ai',
      'app',
      profileQuarantineDirs[0]!,
    )
    expect(readFileSync(join(profileQuarantine, 'profile.previous'), 'utf8')).toBe(
      originalProfile,
    )
    expect(readFileSync(join(profileQuarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
      'reason=profile-rollback-noop-changed',
    )
    expect(racedUpgrade.stdout.toString()).toContain(profileQuarantine)

    rmSync(installedPolo)
    renameSync(join(quarantine, 'polo.previous'), installedPolo)
    rmSync(quarantine, { recursive: true, force: true })
    writeFileSync(profilePath, originalProfile)
    rmSync(profileQuarantine, { recursive: true, force: true })
    rmSync(join(fakeBin, 'ln'))

    writeFileSync(
      join(fakeBin, 'mv'),
      `#!/bin/bash
set -eu
src="$1"
dest="$2"
if [ "$src" = "$POLO_TEST_PROFILE_PATH" ] && [[ "$dest" == */profile.claimed ]]; then
  printf 'outer-uninstall-concurrent-profile\\n' >> "$src"
fi
exec /bin/mv "$@"
`,
    )
    chmodSync(join(fakeBin, 'mv'), 0o755)
    const racedUninstall = Bun.spawnSync(
      ['bash', join(import.meta.dir, 'uninstall-app.sh')],
      {
        env: { ...env, POLO_TEST_PROFILE_PATH: profilePath },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(racedUninstall.exitCode).toBe(2)
    expect(readFileSync(profilePath, 'utf8')).toContain(
      'outer-uninstall-concurrent-profile',
    )
    expect(existsSync(installedPolo)).toBe(true)
    expect(readFileSync(statePath, 'utf8')).toBe(originalState)
    expect(readFileSync(currentPackage, 'utf8')).toBe(originalPackage)
    expect(readFileSync(appImagePath, 'utf8')).toBe(originalAppImage)
    const uninstallQuarantineDirs = readdirSync(join(home, '.polo-ai'))
      .filter((name) => name.startsWith('.terminal-uninstall.'))
    expect(uninstallQuarantineDirs).toHaveLength(1)
    const uninstallQuarantine = join(home, '.polo-ai', uninstallQuarantineDirs[0]!)
    expect(readFileSync(join(uninstallQuarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
      'reason=profile-claim-identity-mismatch',
    )
    expect(racedUninstall.stderr.toString()).toContain(uninstallQuarantine)
    rmSync(uninstallQuarantine, { recursive: true, force: true })
    rmSync(join(fakeBin, 'mv'))

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
