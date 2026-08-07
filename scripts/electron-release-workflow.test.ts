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

  it('requires production approval for manual rollback', () => {
    expect(rollback).toContain('workflow_dispatch:')
    expect(rollback).toContain('environment: production')
    expect(rollback).toContain('/app/publisher rollback')
  })

  it('grants contents write only to GitHub Release jobs', () => {
    expect(release.match(/contents: write/g)).toHaveLength(2)
    expect(release).toContain('Create immutable Draft GitHub Release')
    expect(release).toContain('Publish approved GitHub Release')
  })
})
