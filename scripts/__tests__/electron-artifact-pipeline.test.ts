import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8')

describe('Electron final artifact validation pipeline', () => {
  it('makes final container smoke a builder gate', () => {
    const builder = read('apps/electron/electron-builder.yml')
    const hook = read('apps/electron/scripts/afterAllArtifactBuild.cjs')

    expect(builder).toContain('afterAllArtifactBuild: scripts/afterAllArtifactBuild.cjs')
    expect(hook).toContain('validate-final-artifacts.sh')
    expect(hook).toContain('validate-final-artifacts.ps1')
    expect(hook).toContain("POLO_AI_ARTIFACT_VALIDATION_MODE || 'smoke'")
    expect(hook).toContain('final artifact validation failed')
  })

  it('validates DMG and ZIP mounts, AppImage extraction, and full lifecycle mode', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.sh')

    expect(validator).toContain('Polo-AI-${ARCH}.dmg')
    expect(validator).toContain('Polo-AI-${ARCH}.zip')
    expect(validator).toContain('hdiutil attach')
    expect(validator).toContain('ditto -x -k')
    expect(validator).toContain('--appimage-extract')
    expect(validator).toContain('run_full_e2e')
    expect(validator).toContain('POLO_AI_RUNTIME_DISCOVERY_FILE')
    expect(validator).toContain('"$launcher" sessions')
  })

  it('validates the installed NSIS container and exposes full lifecycle mode', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.ps1')

    expect(validator).toContain('Invoke-Installer')
    expect(validator).toContain('Test-InstalledContainer')
    expect(validator).toContain('Test-FullLifecycle')
    expect(validator).toContain('artifact-manifest.json')
    expect(validator).toContain('& $launcher sessions')
    expect(validator).toContain('Invoke-Uninstaller')
  })

  it('builds and validates dependency-free sanitized CLI metadata', () => {
    const build = read('scripts/build-cli-artifacts.ts')
    const validate = read('scripts/validate-cli-artifacts.ts')
    const afterPack = read('apps/electron/scripts/afterPack.cjs')

    for (const source of [build, validate, afterPack]) {
      expect(source).toContain('dist/cli/package.json')
      expect(source).toContain('cliPackage')
    }
    expect(build).toContain("main: './polo-cli.js'")
    expect(build).toContain("license: sourceCliPackage.license")
    expect(validate).toContain("'dependencies' in cliPackage")
    expect(afterPack).toContain('allowedPackageKeys')
  })
})
