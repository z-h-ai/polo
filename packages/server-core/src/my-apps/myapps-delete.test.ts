import { beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * POO-205 C12 — myapps:delete trusted-side tests.
 *
 * Everything the service reaches beyond the AdminClient is mocked at the
 * module boundary: the committed-fence helpers, the credential/config
 * sources and the AdminClient itself. The assertions pin the DELETE wire
 * path (the scope triple + appId), the scope re-proof refusal, and the
 * staged-bundle cleanup guards (temp-root + `polo-myapps-` prefix only).
 */

const FENCE = {
  workspaceId: 'workspace-a',
  trustedAccountId: 'account-1',
  activeProductSpaceId: 'space-1',
  accessToken: 'admin-token',
}

let deleteCalls: Array<{ token: string; productSpaceId: string; appId: string }> = []
let deleteAnswer: unknown = { contractVersion: 'poo205-contract-r1', appId: 'app-42', deleted: true }
let deleteReject: Error | null = null

class FakeAdminError extends Error {
  readonly errorCode: string
  constructor(code: string, message: string) {
    super(message)
    this.errorCode = code
  }
}

class FakeAdminClient {
  deleteMyApp(token: string, productSpaceId: string, appId: string) {
    deleteCalls.push({ token, productSpaceId, appId })
    if (deleteReject) throw deleteReject
    return Promise.resolve(deleteAnswer)
  }
}

mock.module('../handlers/rpc/trusted-product-space-account', () => ({
  captureCompleteTrustedSessionScopeToken: (workspaceId: string) =>
    workspaceId === FENCE.workspaceId ? { token: 'scope-token' } : null,
  resolveTrustedProductSpaceAccountId: async () => FENCE.trustedAccountId,
  isTrustedSessionScopeTokenCurrent: () => true,
}))

mock.module('../runtime/product-space-executions', () => ({
  isRuntimeFenceBoundToAccount: (accountId: string) => accountId === FENCE.trustedAccountId,
  getRuntimeActiveProductSpace: () => FENCE.activeProductSpaceId,
}))

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => ({
    getAdminTokens: async () => ({ accessToken: FENCE.accessToken }),
  }),
}))

mock.module('@polo-ai/shared/config', () => ({
  getAdminUrl: () => 'https://admin.test',
  getWebAppArtifactPolicyState: () => ({ allowRemoteScripts: false }),
}))

mock.module('@polo-ai/shared/admin', () => ({
  AdminClient: FakeAdminClient,
  AdminError: FakeAdminError,
}))

const { myAppsDelete, cleanupMyAppsTempPath } = await import('./service')

beforeEach(() => {
  deleteCalls = []
  deleteAnswer = { contractVersion: 'poo205-contract-r1', appId: 'app-42', deleted: true }
  deleteReject = null
})

describe('myAppsDelete (POO-205 C12)', () => {
  it('forwards the committed scope + appId through the admin DELETE wire', async () => {
    const answer = await myAppsDelete({
      workspaceId: FENCE.workspaceId,
      productSpaceId: FENCE.activeProductSpaceId,
      appId: 'app-42',
    })
    expect(answer).toEqual({ contractVersion: 'poo205-contract-r1', appId: 'app-42', deleted: true })
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]).toEqual({
      token: FENCE.accessToken,
      productSpaceId: FENCE.activeProductSpaceId,
      appId: 'app-42',
    })
  })

  it('refuses a space that is not the committed one (myapps_scope_changed, wire code attached)', async () => {
    let caught: unknown = null
    try {
      await myAppsDelete({
        workspaceId: FENCE.workspaceId,
        productSpaceId: 'space-OTHER',
        appId: 'app-42',
      })
    } catch (error) {
      caught = error
    }
    expect(caught instanceof Error).toBe(true)
    expect((caught as Error).message).toBe('myapps_scope_changed')
    // The code must ride the Error so the RPC wire keeps myapps_scope_changed
    // instead of degrading to HANDLER_ERROR.
    expect((caught as unknown as { code?: string }).code).toBe('myapps_scope_changed')
    expect(deleteCalls).toHaveLength(0)
  })

  it('refuses an untrusted workspace (myapps_signin_required, no admin call)', async () => {
    let caught: unknown = null
    try {
      await myAppsDelete({
        workspaceId: 'workspace-UNTRUSTED',
        productSpaceId: FENCE.activeProductSpaceId,
        appId: 'app-42',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe('No trusted caller scope is available')
    expect((caught as unknown as { code?: string }).code).toBe('myapps_signin_required')
    expect(deleteCalls).toHaveLength(0)
  })

  it('maps an admin myapps_* code onto the wire error verbatim', async () => {
    deleteReject = new FakeAdminError('myapps_app_not_found', 'no such app')
    let caught: unknown = null
    try {
      await myAppsDelete({
        workspaceId: FENCE.workspaceId,
        productSpaceId: FENCE.activeProductSpaceId,
        appId: 'app-42',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe('myapps_app_not_found')
    expect((caught as unknown as { errorCode?: string }).errorCode).toBe('myapps_app_not_found')
  })
})

describe('cleanupMyAppsTempPath guards (POO-205 C12, 裁决 7)', () => {
  const logs: string[] = []
  const log = (message: string) => logs.push(message)
  const tempRoot = resolve(tmpdir())

  it('removes a staged polo-myapps- directory inside the OS temp root', () => {
    const staging = mkdtempSync(join(tempRoot, 'polo-myapps-'))
    try {
      const bundle = join(staging, 'bundle.zip')
      writeFileSync(bundle, 'zip-bytes')
      logs.length = 0
      cleanupMyAppsTempPath(bundle, log)
      expect(existsSync(staging)).toBe(false)
      expect(logs.some(line => line.includes('[my-apps] cleaning up staged bundle'))).toBe(true)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })

  it('does NOT touch a temp-root directory without the polo-myapps- prefix', () => {
    const foreign = mkdtempSync(join(tempRoot, 'polo-other-'))
    try {
      logs.length = 0
      cleanupMyAppsTempPath(join(foreign, 'bundle.zip'), log)
      expect(existsSync(foreign)).toBe(true)
      expect(logs).toEqual([])
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })

  it('does NOT touch a polo-myapps- directory OUTSIDE the OS temp root', () => {
    const outside = join(resolve(import.meta.dir, '..'), `polo-myapps-test-${process.pid}`)
    mkdirSync(outside, { recursive: true })
    try {
      logs.length = 0
      cleanupMyAppsTempPath(join(outside, 'bundle.zip'), log)
      expect(existsSync(outside)).toBe(true)
      expect(logs).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never deletes the temp root itself', () => {
    logs.length = 0
    cleanupMyAppsTempPath(tempRoot, log)
    expect(existsSync(tempRoot)).toBe(true)
    expect(logs).toEqual([])
  })

  it('keeps the command result alive when the cleanup itself throws', () => {
    // A directory that no longer exists between the guard and rmSync must not
    // throw out of the helper — the finally block swallows (logs only).
    logs.length = 0
    const vanished = join(tempRoot, `polo-myapps-vanished-${process.pid}`)
    expect(() => cleanupMyAppsTempPath(join(vanished, 'bundle.zip'), log)).not.toThrow()
  })
})
