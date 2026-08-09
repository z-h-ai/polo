import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const reusable = readFileSync('.github/workflows/electron-artifact-full.yml', 'utf8')
const release = readFileSync('.github/workflows/electron-release.yml', 'utf8')
const scheduled = readFileSync('.github/workflows/electron-scheduled-validation.yml', 'utf8')
const rollback = readFileSync('.github/workflows/electron-rollback.yml', 'utf8')

describe('Electron release workflow boundaries', () => {
  it('uses a reusable build without release.created publication', () => {
    expect(reusable).toContain('workflow_call:')
    expect(reusable).not.toContain('release:\n    types:')
    expect(reusable).toContain('contents: read')
    expect(reusable).not.toContain('contents: write')
  })

  it('blocks production on all platform builds and Draft Release assembly', () => {
    expect(release).toContain('needs: [preflight, build]')
    expect(release).toContain('needs: [preflight, draft-release]')
    expect(release).toContain('environment: production')
    expect(release).toContain('group: electron-production-release')
    expect(release).toContain('cancel-in-progress: false')
  })

  it('keeps Zeabur credentials and PVC writes out of scheduled validation', () => {
    expect(scheduled).not.toContain('ZEABUR_TOKEN')
    expect(scheduled).not.toContain('/data/releases')
    expect(scheduled).not.toContain('environment: production')
  })

  it('requires production approval to verify a manual rollback', () => {
    expect(rollback).toContain('workflow_dispatch:')
    expect(rollback).toContain('environment: production')
    expect(rollback).toContain('electron-release-bundle.ts verify')
    expect(rollback).not.toContain('ZEABUR_TOKEN')
    expect(rollback).not.toContain('/app/publisher rollback')
  })

  it('pulls the approved Draft Release through the sole PVC writer before public verification', () => {
    expect(release).toContain('Trigger Zeabur release pull')
    expect(release).toContain('ZEABUR_TOKEN')
    expect(release).toContain('ZEABUR_UPDATES_SERVICE_ID')
    expect(release).toContain('npx zeabur@latest service exec')
    expect(release).toContain('/app/polo-release-pull')
    expect(release).toContain('Verify Zeabur updater bundle')
    expect(release).not.toContain('zeabur deploy')
    expect(release).not.toContain('/app/publisher')
  })

  it('rolls back failed public verification and confirms success before publishing the Draft Release', () => {
    const verify = release.indexOf('Verify Zeabur updater bundle')
    const rollback = release.indexOf('Restore latest after failed public verification')
    const stop = release.indexOf('Stop release after public verification failure')
    const confirm = release.indexOf('Confirm Zeabur release after public verification')
    const pointer = release.indexOf('Verify confirmed Zeabur pointer')
    const finalizationRollback = release.indexOf('Restore latest after failed finalization')
    const publish = release.indexOf('publish-release:')

    expect(release).toContain("id: public-verify")
    expect(release).toContain("continue-on-error: true")
    expect(release).toContain("if: steps.public-verify.outcome == 'failure'")
    expect(release).toContain('publish-electron-release.ts rollback-failed')
    expect(release).toContain('publish-electron-release.ts confirm')
    expect(release).toContain('publish-electron-release.ts assert-not-latest')
    expect(release).toContain('publish-electron-release.ts assert-confirmed')
    expect(release).toContain('for attempt in $(seq 1 3); do')
    expect(release).toContain("id: confirm-release")
    expect(release).toContain("id: confirm-pointer")
    expect(release).toContain("if: steps.confirm-release.outcome == 'failure' || steps.confirm-pointer.outcome == 'failure'")
    expect(verify).toBeGreaterThan(0)
    expect(verify).toBeLessThan(rollback)
    expect(rollback).toBeLessThan(stop)
    expect(stop).toBeLessThan(confirm)
    expect(confirm).toBeLessThan(pointer)
    expect(pointer).toBeLessThan(finalizationRollback)
    expect(finalizationRollback).toBeLessThan(publish)
  })

  it('builds and verifies both native macOS manual installers', () => {
    expect(reusable).toContain('runner: macos-15-intel')
    expect(reusable).toContain('runner: macos-15')
    expect(reusable).toContain('arch: x64')
    expect(reusable).toContain('arch: arm64')
    expect(reusable).toContain('manual_installer: Polo-AI-x64.dmg')
    expect(reusable).toContain('manual_installer: Polo-AI-arm64.dmg')
    expect(reusable).toContain('platform: windows')
    expect(reusable).toContain('runner: windows-latest')
    expect(reusable).toContain('Polo-AI-x64.exe')
    expect(reusable).toContain('Get-AuthenticodeSignature')
    expect(reusable).toContain('electron:dist:mac --arch=${{ matrix.arch }}')
    expect(release).toContain('test "$(find existing-release -maxdepth 1 -type f | wc -l)" -eq 9')
  })

  it('grants contents write only to Draft Release assembly and final publishing', () => {
    expect(release.match(/contents: write/g)).toHaveLength(2)
    expect(release).toContain('Create immutable Draft GitHub Release')
    expect(release).toContain('Publish approved GitHub Release')
  })
})
