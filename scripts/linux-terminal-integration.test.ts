import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const helper = join(
  repoRoot,
  'apps',
  'electron',
  'resources',
  'scripts',
  'linux-terminal-integration.sh',
)
const canonicalPolo = join(
  repoRoot,
  'apps',
  'electron',
  'resources',
  'bin',
  'polo',
)
const canonicalCompat = join(
  repoRoot,
  'apps',
  'electron',
  'resources',
  'bin',
  'polo-ai',
)
const canonicalMessages = join(
  repoRoot,
  'apps',
  'electron',
  'resources',
  'bin',
  'polo-messages.sh',
)
const roots: string[] = []

interface Fixture {
  root: string
  appDir: string
  binDir: string
  poloTarget: string
  compatTarget: string
  poloPath: string
  compatPath: string
  statePath: string
  profilePath: string
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'polo linux ownership 空格 '))
  roots.push(root)
  const appDir = join(root, '.polo-ai', 'app')
  const binDir = join(root, '.local', 'bin')
  const wrapperDir = join(appDir, 'current', 'resources', 'app', 'resources', 'bin')
  mkdirSync(wrapperDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  const poloTarget = join(wrapperDir, 'polo')
  const compatTarget = join(wrapperDir, 'polo-ai')
  copyFileSync(canonicalPolo, poloTarget)
  copyFileSync(canonicalCompat, compatTarget)
  copyFileSync(canonicalMessages, join(wrapperDir, 'polo-messages.sh'))
  chmodSync(poloTarget, 0o755)
  chmodSync(compatTarget, 0o755)
  const profilePath = join(root, '.zprofile')
  writeFileSync(
    profilePath,
    '# >>> Polo CLI >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n',
  )
  return {
    root,
    appDir,
    binDir,
    poloTarget,
    compatTarget,
    poloPath: join(binDir, 'polo'),
    compatPath: join(binDir, 'polo-ai'),
    statePath: join(root, '.polo-ai', 'terminal-integration-linux.state'),
    profilePath,
  }
}

function runHelper(
  mode:
    | 'preflight'
    | 'install'
    | 'verify-uninstall'
    | 'path-entry-owned'
    | 'profile-path'
    | 'uninstall',
  value: Fixture,
  options: {
    env?: Record<string, string>
    profilePath?: string
    pathEntryOwned?: 'true' | 'false'
  } = {},
): ReturnType<typeof Bun.spawnSync> {
  const args = [
    'bash',
    helper,
    mode,
    '--app-dir',
    value.appDir,
    '--bin-dir',
    value.binDir,
  ]
  if (mode === 'preflight' || mode === 'install') {
    args.push(
      '--version',
      '0.10.0',
      '--staged-polo',
      value.poloTarget,
      '--staged-compat',
      value.compatTarget,
    )
  }
  if (mode === 'install') {
    args.push('--path-entry-owned', options.pathEntryOwned ?? 'true')
    if ((options.pathEntryOwned ?? 'true') === 'true') {
      args.push('--profile-path', options.profilePath ?? value.profilePath)
    }
  }
  return Bun.spawnSync(args, {
    env: { ...process.env, HOME: value.root, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function install(value: Fixture): void {
  expect(runHelper('preflight', value).exitCode).toBe(0)
  expect(runHelper('install', value).exitCode).toBe(0)
}

function racingLnEnvironment(
  value: Fixture,
  failCall: number,
  createRace = true,
): Record<string, string> {
  const fakeBin = join(value.root, `race-ln-${failCall}`)
  const countFile = join(fakeBin, 'count')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(
    join(fakeBin, 'ln'),
    `#!/bin/bash
set -eu
count=0
[ ! -f "$POLO_TEST_LN_COUNT" ] || count="$(cat "$POLO_TEST_LN_COUNT")"
count=$((count + 1))
printf '%s\\n' "$count" > "$POLO_TEST_LN_COUNT"
if [ "$count" -eq "$POLO_TEST_FAIL_LN_CALL" ]; then
  for last; do :; done
  if [ "$POLO_TEST_CREATE_RACE" = "true" ]; then
    printf 'concurrent-user-file-%s\\n' "$count" > "$last"
  fi
  exit 73
fi
exec /bin/ln "$@"
`,
  )
  chmodSync(join(fakeBin, 'ln'), 0o755)
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    POLO_TEST_LN_COUNT: countFile,
    POLO_TEST_FAIL_LN_CALL: String(failCall),
    POLO_TEST_CREATE_RACE: createRace ? 'true' : 'false',
  }
}

function racingProfileMvEnvironment(
  value: Fixture,
  mode: 'regular' | 'symlink' | 'rename' | 'content',
): Record<string, string> {
  const fakeBin = join(value.root, `race-profile-mv-${mode}`)
  const userTarget = join(fakeBin, 'user-profile-target')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(userTarget, `concurrent-user-profile-${mode}\n`)
  writeFileSync(
    join(fakeBin, 'mv'),
    `#!/bin/bash
set -eu
src="$1"
dest="$2"
if [ "$src" = "$POLO_TEST_PROFILE_PATH" ] && [[ "$dest" == */profile.claimed ]]; then
  case "$POLO_TEST_PROFILE_RACE" in
    regular)
      printf 'concurrent-user-profile-regular\\n' > "$src"
      ;;
    symlink)
      rm -f "$src"
      /bin/ln -s "$POLO_TEST_PROFILE_USER_TARGET" "$src"
      ;;
    rename)
      /bin/mv "$src" "$src.concurrent-renamed"
      printf 'concurrent-user-profile-rename\\n' > "$src"
      ;;
    content)
      printf 'concurrent-user-profile-content\\n' >> "$src"
      ;;
  esac
fi
exec /bin/mv "$@"
`,
  )
  chmodSync(join(fakeBin, 'mv'), 0o755)
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    POLO_TEST_PROFILE_PATH: value.profilePath,
    POLO_TEST_PROFILE_RACE: mode,
    POLO_TEST_PROFILE_USER_TARGET: userTarget,
  }
}

function racingProfilePublishEnvironment(
  value: Fixture,
  mode: 'regular' | 'symlink',
): Record<string, string> {
  const fakeBin = join(value.root, `race-profile-publish-${mode}`)
  const userTarget = join(fakeBin, 'user-profile-target')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(userTarget, `publish-user-profile-${mode}\n`)
  writeFileSync(
    join(fakeBin, 'ln'),
    `#!/bin/bash
set -eu
for last; do :; done
if [ "$last" = "$POLO_TEST_PROFILE_PATH" ]; then
  case "$POLO_TEST_PROFILE_RACE" in
    regular) printf 'publish-user-profile-regular\\n' > "$last" ;;
    symlink) /bin/ln -s "$POLO_TEST_PROFILE_USER_TARGET" "$last" ;;
  esac
  exit 73
fi
exec /bin/ln "$@"
`,
  )
  chmodSync(join(fakeBin, 'ln'), 0o755)
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    POLO_TEST_PROFILE_PATH: value.profilePath,
    POLO_TEST_PROFILE_RACE: mode,
    POLO_TEST_PROFILE_USER_TARGET: userTarget,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Linux terminal integration ownership', () => {
  it('records schema 4 path, target, profile, content hash, and identity before safe uninstall', () => {
    const value = fixture()
    install(value)

    expect(lstatSync(value.poloPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(value.poloPath)).toBe(realpathSync(value.poloTarget))
    const state = readFileSync(value.statePath, 'utf8')
    expect(state).toContain('schemaVersion=4\n')
    expect(state).toContain('owner=com.poloai.terminal-integration\n')
    expect(state).toContain('format=managed-symlink-v1\n')
    expect(state).toMatch(/polo_sha256=[0-9a-f]{64}/)
    expect(state).toMatch(/polo_identity=[0-9a-f]{64}/)
    expect(state).toContain('profile_path_b64=')
    expect(state).toMatch(/profile_block_sha256=[0-9a-f]{64}/)
    expect(state).toMatch(/state_identity=[0-9a-f]{64}/)

    expect(runHelper('uninstall', value).exitCode).toBe(0)
    expect(existsSync(value.poloPath)).toBe(false)
    expect(existsSync(value.compatPath)).toBe(false)
    expect(existsSync(value.statePath)).toBe(false)
    expect(readFileSync(value.profilePath, 'utf8')).not.toContain('# >>> Polo CLI >>>')
  })

  it('rejects missing or malformed owned profiles before creating launchers or state', () => {
    const missing = fixture()
    rmSync(missing.profilePath)
    const missingResult = runHelper('install', missing)
    expect(missingResult.exitCode).not.toBe(0)
    expect(existsSync(missing.poloPath)).toBe(false)
    expect(existsSync(missing.compatPath)).toBe(false)
    expect(existsSync(missing.statePath)).toBe(false)

    const malformed = fixture()
    writeFileSync(
      malformed.profilePath,
      '# >>> Polo CLI >>>\nexport PATH="/user/bin:$PATH"\n# <<< Polo CLI <<<\n',
    )
    const malformedResult = runHelper('install', malformed)
    expect(malformedResult.exitCode).not.toBe(0)
    expect(existsSync(malformed.poloPath)).toBe(false)
    expect(existsSync(malformed.compatPath)).toBe(false)
    expect(existsSync(malformed.statePath)).toBe(false)
  })

  it('binds profile and path ownership into the full state identity', () => {
    for (const field of ['profile_path_b64', 'path_entry_owned']) {
      const value = fixture()
      install(value)
      const bashProfile = join(value.root, '.bash_profile')
      writeFileSync(
        bashProfile,
        '# >>> Polo CLI >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n',
      )
      const state = readFileSync(value.statePath, 'utf8')
      const tampered =
        field === 'profile_path_b64'
          ? state.replace(
              /^profile_path_b64=.*$/m,
              `profile_path_b64=${Buffer.from(bashProfile).toString('base64')}`,
            )
          : state.replace(/^path_entry_owned=true$/m, 'path_entry_owned=false')
      writeFileSync(value.statePath, tampered)

      expect(runHelper('profile-path', value).exitCode).toBe(2)
      expect(runHelper('uninstall', value).exitCode).toBe(2)
      expect(lstatSync(value.poloPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(value.profilePath, 'utf8')).toContain('# >>> Polo CLI >>>')
      expect(readFileSync(bashProfile, 'utf8')).toContain('# >>> Polo CLI >>>')
    }
  })

  it('never authorizes a different supported profile that is not bound by state', () => {
    const value = fixture()
    install(value)
    const bashProfile = join(value.root, '.bash_profile')
    const bashContent =
      'export USER_SETTING=1\n# >>> Polo CLI >>>\n'
      + 'export PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n'
    writeFileSync(bashProfile, bashContent)

    expect(runHelper('profile-path', value).stdout.toString().trim()).toBe(value.profilePath)
    expect(runHelper('uninstall', value).exitCode).toBe(0)
    expect(readFileSync(bashProfile, 'utf8')).toBe(bashContent)
  })

  it('preserves the reviewer copied-marker file when ownership state is absent', () => {
    const value = fixture()
    writeFileSync(value.poloPath, '# Polo CLI launcher (managed by Polo AI)\n')

    const result = runHelper('uninstall', value)

    expect(result.exitCode).toBe(2)
    expect(readFileSync(value.poloPath, 'utf8')).toBe(
      '# Polo CLI launcher (managed by Polo AI)\n',
    )
  })

  it('preserves user symlinks even when they point to the canonical target', () => {
    const value = fixture()
    symlinkSync(value.poloTarget, value.poloPath)
    symlinkSync(value.compatTarget, value.compatPath)

    expect(runHelper('uninstall', value).exitCode).toBe(2)
    expect(lstatSync(value.poloPath).isSymbolicLink()).toBe(true)
  })

  it('revalidates ownership inside install and never overwrites direct user files', () => {
    const direct = fixture()
    writeFileSync(direct.poloPath, '#!/bin/sh\necho user-polo\n')
    writeFileSync(direct.compatPath, '#!/bin/sh\necho user-compat\n')

    const directResult = runHelper('install', direct)

    expect(directResult.exitCode).not.toBe(0)
    expect(readFileSync(direct.poloPath, 'utf8')).toContain('user-polo')
    expect(readFileSync(direct.compatPath, 'utf8')).toContain('user-compat')
    expect(existsSync(direct.statePath)).toBe(false)
  })

  it('rejects a launcher replaced after preflight and preserves the replacement', () => {
    const value = fixture()
    install(value)
    expect(runHelper('preflight', value).exitCode).toBe(0)
    rmSync(value.poloPath)
    writeFileSync(value.poloPath, '#!/bin/sh\necho replaced-after-preflight\n')

    const result = runHelper('install', value)

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(value.poloPath, 'utf8')).toContain('replaced-after-preflight')
  })

  it('keeps normal repair and verified uninstall working', () => {
    const value = fixture()
    install(value)
    expect(runHelper('install', value).exitCode).toBe(0)
    expect(runHelper('verify-uninstall', value).exitCode).toBe(0)
    expect(runHelper('path-entry-owned', value).stdout.toString().trim()).toBe('true')
    expect(runHelper('uninstall', value).exitCode).toBe(0)
  })

  it('requires repair to bind legacy schema 4 state before uninstall', () => {
    const value = fixture()
    install(value)
    const legacyState = readFileSync(value.statePath, 'utf8')
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('profile_block_sha256=') && !line.startsWith('state_identity='),
      )
      .join('\n')
    writeFileSync(value.statePath, legacyState)

    expect(runHelper('verify-uninstall', value).exitCode).toBe(2)
    expect(runHelper('preflight', value).exitCode).toBe(0)
    expect(runHelper('install', value).exitCode).toBe(0)
    expect(readFileSync(value.statePath, 'utf8')).toMatch(/state_identity=[0-9a-f]{64}/)
    expect(runHelper('uninstall', value).exitCode).toBe(0)
  })

  it('persists rollback candidates when polo, compat, or state is concurrently occupied', () => {
    const cases = [
      { failCall: 1, occupied: 'polo', candidate: 'polo.previous' },
      { failCall: 2, occupied: 'polo-ai', candidate: 'polo-ai.previous' },
      { failCall: 3, occupied: 'terminal-integration-linux.state', candidate: 'state.previous' },
    ] as const

    for (const testCase of cases) {
      const value = fixture()
      install(value)
      const oldState = readFileSync(value.statePath, 'utf8')
      const result = runHelper('install', value, {
        env: racingLnEnvironment(value, testCase.failCall),
      })

      expect(result.exitCode).not.toBe(0)
      const occupiedPath =
        testCase.occupied === 'polo'
          ? value.poloPath
          : testCase.occupied === 'polo-ai'
            ? value.compatPath
            : value.statePath
      expect(readFileSync(occupiedPath, 'utf8')).toContain('concurrent-user-file')
      const quarantineDirs = readdirSync(join(value.root, '.polo-ai'))
        .filter((name) => name.startsWith('.terminal-install.'))
      expect(quarantineDirs).toHaveLength(1)
      const quarantine = join(value.root, '.polo-ai', quarantineDirs[0]!)
      expect(existsSync(join(quarantine, testCase.candidate))).toBe(true)
      expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
        'reason=concurrent-path-occupation',
      )
      expect(result.stderr.toString()).toContain(quarantine)
      if (testCase.failCall !== 3) {
        expect(readFileSync(value.statePath, 'utf8')).toBe(oldState)
      }
    }
  })

  it('fully restores managed entries and removes quarantine after a helper failure without a race', () => {
    const value = fixture()
    install(value)
    const oldState = readFileSync(value.statePath, 'utf8')
    const oldPoloTarget = readlinkSync(value.poloPath)
    const oldCompatTarget = readlinkSync(value.compatPath)

    const result = runHelper('install', value, {
      env: racingLnEnvironment(value, 2, false),
    })

    expect(result.exitCode).not.toBe(0)
    expect(readlinkSync(value.poloPath)).toBe(oldPoloTarget)
    expect(readlinkSync(value.compatPath)).toBe(oldCompatTarget)
    expect(readFileSync(value.statePath, 'utf8')).toBe(oldState)
    expect(
      readdirSync(join(value.root, '.polo-ai')).filter((name) =>
        name.startsWith('.terminal-install.'),
      ),
    ).toHaveLength(0)
  })

  it('claims the verified profile and preserves regular, symlink, rename, and content races', () => {
    for (const mode of ['regular', 'symlink', 'rename', 'content'] as const) {
      const value = fixture()
      install(value)
      const stateBefore = readFileSync(value.statePath, 'utf8')
      const poloTargetBefore = readlinkSync(value.poloPath)
      const compatTargetBefore = readlinkSync(value.compatPath)

      const result = runHelper('uninstall', value, {
        env: racingProfileMvEnvironment(value, mode),
      })

      expect(result.exitCode).toBe(2)
      expect(readlinkSync(value.poloPath)).toBe(poloTargetBefore)
      expect(readlinkSync(value.compatPath)).toBe(compatTargetBefore)
      expect(readFileSync(value.statePath, 'utf8')).toBe(stateBefore)
      if (mode === 'symlink') {
        expect(lstatSync(value.profilePath).isSymbolicLink()).toBe(true)
        expect(readFileSync(value.profilePath, 'utf8')).toContain(
          'concurrent-user-profile-symlink',
        )
      } else {
        expect(readFileSync(value.profilePath, 'utf8')).toContain(
          `concurrent-user-profile-${mode}`,
        )
      }
      if (mode === 'rename') {
        expect(readFileSync(`${value.profilePath}.concurrent-renamed`, 'utf8')).toContain(
          '# >>> Polo CLI >>>',
        )
      }
      const quarantineDirs = readdirSync(join(value.root, '.polo-ai'))
        .filter((name) => name.startsWith('.terminal-uninstall.'))
      expect(quarantineDirs).toHaveLength(1)
      const quarantine = join(value.root, '.polo-ai', quarantineDirs[0]!)
      expect(readFileSync(join(quarantine, 'profile.owned'), 'utf8')).toContain(
        '# >>> Polo CLI >>>',
      )
      expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
        'reason=profile-claim-identity-mismatch',
      )
      expect(result.stderr.toString()).toContain(quarantine)
    }
  })

  it('publishes the cleaned profile with no-replace when a file or symlink appears', () => {
    for (const mode of ['regular', 'symlink'] as const) {
      const value = fixture()
      install(value)
      const stateBefore = readFileSync(value.statePath, 'utf8')

      const result = runHelper('uninstall', value, {
        env: racingProfilePublishEnvironment(value, mode),
      })

      expect(result.exitCode).toBe(2)
      expect(lstatSync(value.poloPath).isSymbolicLink()).toBe(true)
      expect(lstatSync(value.compatPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(value.statePath, 'utf8')).toBe(stateBefore)
      if (mode === 'symlink') {
        expect(lstatSync(value.profilePath).isSymbolicLink()).toBe(true)
      }
      expect(readFileSync(value.profilePath, 'utf8')).toContain(
        `publish-user-profile-${mode}`,
      )
      const quarantineDirs = readdirSync(join(value.root, '.polo-ai'))
        .filter((name) => name.startsWith('.terminal-uninstall.'))
      expect(quarantineDirs).toHaveLength(1)
      const quarantine = join(value.root, '.polo-ai', quarantineDirs[0]!)
      expect(readFileSync(join(quarantine, 'profile.claimed'), 'utf8')).toContain(
        '# >>> Polo CLI >>>',
      )
      expect(readFileSync(join(quarantine, 'ROLLBACK_REQUIRED'), 'utf8')).toContain(
        'reason=profile-replacement-occupied',
      )
      expect(result.stderr.toString()).toContain(quarantine)
    }
  })

  it('migrates only the exact pre-POO-14 Linux GUI launcher template', () => {
    const value = fixture()
    writeFileSync(
      value.compatPath,
      `#!/bin/bash
# Polo AI launcher - handles Linux-specific AppImage issues

APPIMAGE_PATH="$HOME/.polo-ai/app/Polo-AI-x64.AppImage"
ELECTRON_CACHE="$HOME/.config/@polo-ai"
ELECTRON_CACHE_ALT="$HOME/.cache/@polo-ai"

# Verify AppImage exists
if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "Error: Polo AI not found at $APPIMAGE_PATH"
    echo "Reinstall: curl -fsSL https://polo.ai/install-app.sh | bash"
    exit 1
fi

# Ensure DISPLAY is set (required for X11)
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0.0
fi

# Clear stale cache referencing AppImage mount paths
# AppImage creates a new /tmp/.mount_Craft-XXXX each launch, so any cached path is stale
for cache_dir in "$ELECTRON_CACHE" "$ELECTRON_CACHE_ALT"; do
    if [ -d "$cache_dir" ] && grep -rq '/tmp/\\.mount_Craft' "$cache_dir" 2>/dev/null; then
        rm -rf "$cache_dir"
    fi
done

# Set APPIMAGE for auto-update
export APPIMAGE="$APPIMAGE_PATH"

# Launch with --no-sandbox (AppImage extracts to /tmp, losing SUID on chrome-sandbox)
exec "$APPIMAGE_PATH" --no-sandbox "$@"
`,
    )

    expect(runHelper('preflight', value).exitCode).toBe(0)
    expect(runHelper('install', value).exitCode).toBe(0)
    expect(lstatSync(value.compatPath).isSymbolicLink()).toBe(true)
  })

  it('blocks repair and uninstall for corrupt state, edited targets, and replaced links', () => {
    const corrupt = fixture()
    install(corrupt)
    writeFileSync(corrupt.statePath, 'schemaVersion=3\nowner=attacker\n')
    expect(runHelper('preflight', corrupt).exitCode).not.toBe(0)
    expect(runHelper('uninstall', corrupt).exitCode).toBe(2)
    expect(lstatSync(corrupt.poloPath).isSymbolicLink()).toBe(true)

    const edited = fixture()
    install(edited)
    writeFileSync(edited.poloTarget, `${readFileSync(edited.poloTarget, 'utf8')}\n# changed\n`)
    expect(runHelper('preflight', edited).exitCode).not.toBe(0)
    expect(runHelper('uninstall', edited).exitCode).toBe(2)

    const replaced = fixture()
    install(replaced)
    const userTarget = join(replaced.root, 'user-polo')
    writeFileSync(userTarget, '#!/bin/sh\n')
    rmSync(replaced.poloPath)
    symlinkSync(userTarget, replaced.poloPath)
    expect(runHelper('uninstall', replaced).exitCode).toBe(2)
    expect(readlinkSync(replaced.poloPath)).toBe(userTarget)
  })
})

describe('Linux canonical wrapper behavior', () => {
  it('forwards app/run/sessions through bundled Bun from a space and non-ASCII path', () => {
    const value = fixture()
    const resourcesRoot = join(value.appDir, 'current', 'resources')
    const bun = join(resourcesRoot, 'vendor', 'bun', 'bun')
    const cli = join(resourcesRoot, 'app', 'dist', 'cli', 'polo-cli.js')
    const server = join(resourcesRoot, 'app', 'dist', 'server', 'polo-server.js')
    const appImage = join(value.appDir, 'Polo-AI-x64.AppImage')
    const fakeBin = join(value.root, 'fake-bin')
    mkdirSync(dirname(bun), { recursive: true })
    mkdirSync(dirname(cli), { recursive: true })
    mkdirSync(dirname(server), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(
      bun,
      '#!/bin/sh\nprintf "bun-args=%s\\n" "$*"\nprintf "appimage=%s\\n" "$POLO_AI_APPIMAGE"\nexit 23\n',
    )
    chmodSync(bun, 0o755)
    writeFileSync(cli, 'cli fixture\n')
    writeFileSync(server, 'server fixture\n')
    writeFileSync(appImage, '#!/bin/sh\n')
    chmodSync(appImage, 0o755)
    writeFileSync(join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n')
    chmodSync(join(fakeBin, 'uname'), 0o755)
    install(value)

    for (const args of [['app'], ['run', 'hello world'], ['sessions']]) {
      const result = Bun.spawnSync([value.poloPath, ...args], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(23)
      expect(result.stdout.toString()).toContain(
        `bun-args=run ${realpathSync(cli)} ${args.join(' ')}`,
      )
      expect(result.stdout.toString()).toContain(`appimage=${realpathSync(appImage)}`)
    }
    expect(readFileSync(value.poloTarget, 'utf8')).toBe(readFileSync(canonicalPolo, 'utf8'))
    expect(readFileSync(value.compatTarget, 'utf8')).toBe(readFileSync(canonicalCompat, 'utf8'))
  })
})
