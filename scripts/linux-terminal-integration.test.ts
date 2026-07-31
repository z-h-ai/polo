import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  chmodSync(poloTarget, 0o755)
  chmodSync(compatTarget, 0o755)
  return {
    root,
    appDir,
    binDir,
    poloTarget,
    compatTarget,
    poloPath: join(binDir, 'polo'),
    compatPath: join(binDir, 'polo-ai'),
    statePath: join(root, '.polo-ai', 'terminal-integration-linux.state'),
  }
}

function runHelper(
  mode: 'preflight' | 'install' | 'uninstall',
  value: Fixture,
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
  if (mode !== 'uninstall') {
    args.push(
      '--version',
      '0.10.0',
      '--staged-polo',
      value.poloTarget,
      '--staged-compat',
      value.compatTarget,
    )
  }
  if (mode === 'install') args.push('--path-entry-owned', 'true')
  return Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
}

function install(value: Fixture): void {
  expect(runHelper('preflight', value).exitCode).toBe(0)
  expect(runHelper('install', value).exitCode).toBe(0)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Linux terminal integration ownership', () => {
  it('records schema 3 path, target, content hash, and identity before safe uninstall', () => {
    const value = fixture()
    install(value)

    expect(lstatSync(value.poloPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(value.poloPath)).toBe(realpathSync(value.poloTarget))
    const state = readFileSync(value.statePath, 'utf8')
    expect(state).toContain('schemaVersion=3\n')
    expect(state).toContain('owner=com.poloai.terminal-integration\n')
    expect(state).toContain('format=managed-symlink-v1\n')
    expect(state).toMatch(/polo_sha256=[0-9a-f]{64}/)
    expect(state).toMatch(/polo_identity=[0-9a-f]{64}/)

    expect(runHelper('uninstall', value).exitCode).toBe(0)
    expect(existsSync(value.poloPath)).toBe(false)
    expect(existsSync(value.compatPath)).toBe(false)
    expect(existsSync(value.statePath)).toBe(false)
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
