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

  it('keeps the manual production gate free of Zeabur write credentials', () => {
    expect(release).toContain('Verify manually uploaded updater bundle')
    expect(release).toContain('Verify manually uploaded DMG')
    expect(release).not.toContain('ZEABUR_TOKEN')
    expect(release).not.toContain('zeabur deploy')
    expect(release).not.toContain('/app/publisher')
  })

  it('builds and verifies both native macOS manual installers', () => {
    expect(reusable).toContain('runner: macos-15-intel')
    expect(reusable).toContain('runner: macos-15')
    expect(reusable).toContain('arch: x64')
    expect(reusable).toContain('arch: arm64')
    expect(reusable).toContain('manual_installer: Polo-AI-x64.dmg')
    expect(reusable).toContain('manual_installer: Polo-AI-arm64.dmg')
    expect(reusable).toContain('electron:dist:mac --arch=${{ matrix.arch }}')
    expect(release).toContain('test -f collected/Polo-AI-x64.dmg')
    expect(release).toContain('test -f collected/Polo-AI-arm64.dmg')
    expect(release).toContain('for arch in x64 arm64; do')
  })

  it('grants contents write only to Draft Release, production verification, and publishing', () => {
    expect(release.match(/contents: write/g)).toHaveLength(3)
    expect(release).toContain('Create immutable Draft GitHub Release')
    expect(release).toContain('Production needs this permission only to download the expected DMG')
    expect(release).toContain('Publish approved GitHub Release')
  })
})
