import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const repoRoot = join(import.meta.dir, '..', '..')
const script = join(repoRoot, 'scripts', 'preflight-previous-release.sh')
const commit = '0123456789abcdef0123456789abcdef01234567'
const artifactBody = 'trusted previous artifact\n'
const installerBody = '#!/bin/sh\n# trusted previous installer\n'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polo previous preflight '))
  roots.push(root)
  const fakeBin = join(root, 'bin')
  const previous = join(root, 'previous')
  const calls = join(root, 'calls.log')
  mkdirSync(fakeBin, { recursive: true })
  mkdirSync(previous, { recursive: true })
  writeFileSync(
    join(fakeBin, 'git'),
    `#!/bin/bash
printf 'git %s\\n' "$*" >> "$POLO_TEST_CALLS"
case "$1" in
  fetch) exit 0 ;;
  rev-list) printf '${commit}\\n' ;;
  show) printf '{\\n  "version": "%s"\\n}\\n' "$PREVIOUS_RELEASE_VERSION" ;;
  *) exit 64 ;;
esac
`,
  )
  writeFileSync(
    join(fakeBin, 'gh'),
    `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$POLO_TEST_CALLS"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--json" ]; then
      case "$2" in
        tagName) printf '%s\\n' "$PREVIOUS_RELEASE_TAG" ;;
        url) printf 'https://github.com/z-h-ai/polo/releases/tag/%s\\n' "$PREVIOUS_RELEASE_TAG" ;;
        isDraft) printf 'false\\n' ;;
      esac
      exit 0
    fi
    shift
  done
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) name="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf 'trusted previous artifact\\n' > "$dir/$name"
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '#!/bin/sh\\n# trusted previous installer\\n'
  exit 0
fi
exit 64
`,
  )
  chmodSync(join(fakeBin, 'git'), 0o755)
  chmodSync(join(fakeBin, 'gh'), 0o755)
  return {
    root,
    fakeBin,
    previous,
    calls,
    artifact: join(previous, 'Polo-AI-x64.zip'),
    installer: join(previous, 'install-app.sh'),
    output: join(previous, 'verified-contract-macos.json'),
    githubEnv: join(root, 'github.env'),
  }
}

function envFor(value: ReturnType<typeof fixture>): Record<string, string> {
  return {
    ...process.env,
    PATH: `${value.fakeBin}:${process.env.PATH ?? ''}`,
    RUNNER_TEMP: value.root,
    GITHUB_ENV: value.githubEnv,
    GITHUB_REPOSITORY: 'z-h-ai/polo',
    PREVIOUS_RELEASE_TAG: 'v0.9.0',
    PREVIOUS_RELEASE_VERSION: '0.9.0',
    PREVIOUS_RELEASE_COMMIT_SHA: commit,
    EXPECTED_PREVIOUS_ARTIFACT_SHA256: digest(artifactBody),
    EXPECTED_PREVIOUS_INSTALLER_SHA256: digest(installerBody),
    POLO_AI_PREVIOUS_ARTIFACT: value.artifact,
    POLO_AI_PREVIOUS_INSTALL_SCRIPT: value.installer,
    POLO_TEST_CALLS: value.calls,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('previous release runner-only preflight', () => {
  it('pins provenance and both hashes before persisting the verified contract', () => {
    const value = fixture()
    const result = Bun.spawnSync(
      [
        'bash',
        script,
        '--platform',
        'macos',
        '--artifact-name',
        'Polo-AI-x64.zip',
        '--output',
        value.output,
      ],
      { cwd: repoRoot, env: envFor(value), stdout: 'pipe', stderr: 'pipe' },
    )

    expect(result.exitCode).toBe(0)
    expect(readFileSync(value.artifact, 'utf8')).toBe(artifactBody)
    expect(readFileSync(value.installer, 'utf8')).toBe(installerBody)
    const contract = JSON.parse(readFileSync(value.output, 'utf8'))
    expect(contract).toMatchObject({
      repository: 'z-h-ai/polo',
      tag: 'v0.9.0',
      version: '0.9.0',
      commitSha: commit,
      releaseUrl: 'https://github.com/z-h-ai/polo/releases/tag/v0.9.0',
      artifact: { sha256: digest(artifactBody) },
      installer: { sha256: digest(installerBody) },
    })
    expect(readFileSync(value.githubEnv, 'utf8')).toContain(
      'CURRENT_ELECTRON_VERSION=0.10.0',
    )
  })

  it('fails before provenance tools or downloads when the contract is incomplete', () => {
    const value = fixture()
    const env = envFor(value)
    delete env.EXPECTED_PREVIOUS_ARTIFACT_SHA256

    const result = Bun.spawnSync(
      [
        'bash',
        script,
        '--platform',
        'macos',
        '--artifact-name',
        'Polo-AI-x64.zip',
        '--output',
        value.output,
      ],
      { cwd: repoRoot, env, stdout: 'pipe', stderr: 'pipe' },
    )

    expect(result.exitCode).not.toBe(0)
    expect(existsSync(value.calls)).toBe(false)
    expect(existsSync(value.artifact)).toBe(false)
    expect(existsSync(value.output)).toBe(false)
  })

  it('accepts anchored semver prerelease and build tags', () => {
    const value = fixture()
    const env = envFor(value)
    env.PREVIOUS_RELEASE_TAG = 'v0.9.0-rc.1+build.7'
    env.PREVIOUS_RELEASE_VERSION = '0.9.0-rc.1+build.7'

    const result = Bun.spawnSync(
      [
        'bash',
        script,
        '--platform',
        'macos',
        '--artifact-name',
        'Polo-AI-x64.zip',
        '--output',
        value.output,
      ],
      { cwd: repoRoot, env, stdout: 'pipe', stderr: 'pipe' },
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(value.output, 'utf8')).tag).toBe(
      'v0.9.0-rc.1+build.7',
    )
  })

  it('rejects malformed or unanchored semantic tags before provenance access', () => {
    for (const tag of [
      'v1x.2y.3z',
      'v1.2.3evil',
      'v1.2.3-',
      'v1.2.3+',
      'v1.2.3-alpha..1',
      'v1.2.3+build..1',
      'v01.2.3',
      'v1.02.3',
      'v1.2.03',
      'v1.2.3-01',
      'v1.2.3+build.7tail!',
    ]) {
      const value = fixture()
      const env = envFor(value)
      env.PREVIOUS_RELEASE_TAG = tag
      const result = Bun.spawnSync(
        [
          'bash',
          script,
          '--platform',
          'macos',
          '--artifact-name',
          'Polo-AI-x64.zip',
          '--output',
          value.output,
        ],
        { cwd: repoRoot, env, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(value.calls)).toBe(false)
      expect(existsSync(value.output)).toBe(false)
    }
  })

  it('rejects malformed pinned versions before provenance access', () => {
    for (const version of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-',
      '1.2.3+',
      '1.2.3-alpha..1',
      '1.2.3+build..1',
      '1x2x3',
      '1.2.3evil',
    ]) {
      const value = fixture()
      const env = envFor(value)
      env.PREVIOUS_RELEASE_VERSION = version
      const result = Bun.spawnSync(
        [
          'bash',
          script,
          '--platform',
          'macos',
          '--artifact-name',
          'Polo-AI-x64.zip',
          '--output',
          value.output,
        ],
        { cwd: repoRoot, env, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(value.calls)).toBe(false)
      expect(existsSync(value.output)).toBe(false)
    }
  })
})
