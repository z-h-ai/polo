import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { getPol53SourceCandidates } from './electron-phone-auth-e2e-utils'

describe('Electron phone auth E2E POL-53 discovery', () => {
  it('discovers dependency worktrees relative to the current polo worktree', () => {
    const root = '/workspace/polo-dir/POO-8/feature/electron-phone-reg'

    expect(getPol53SourceCandidates(root, undefined)).toEqual([
      '/workspace/polo-admin-dir/dev',
      '/workspace/polo-admin-dir/main',
    ])
  })

  it('uses an explicit POL53_WORKTREE without a user-specific fallback', () => {
    expect(getPol53SourceCandidates(
      '/workspace/polo-dir/POO-8/feature/electron-phone-reg',
      ' ./dependency/polo-admin ',
    )).toEqual([resolve('./dependency/polo-admin')])
  })
})
