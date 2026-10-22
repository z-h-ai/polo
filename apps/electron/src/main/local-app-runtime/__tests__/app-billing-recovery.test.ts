import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppBillingOutbox } from '../app-billing-outbox'
import { LocalAppRuntimeCoordinator } from '../runtime-coordinator'

it('restores pre-admission only by scoped lookup and receipts only by immutable replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'app-billing-recovery-'))
  const scope = { accountId: 'account-a', adminOrigin: 'https://original.example.com', productSpaceId: crypto.randomUUID(), artifactInstanceId: crypto.randomUUID(), artifactVersionId: crypto.randomUUID() }
  const runId = crypto.randomUUID()
  const firstRequest = crypto.randomUUID(), secondRequest = crypto.randomUUID()
  const outbox = new AppBillingOutbox(directory)
  const admission = { productSpaceId: scope.productSpaceId, requestId: firstRequest, model: 'model', hostRequestId: `host-${crypto.randomUUID()}`, transportBaseUrl: 'https://api.example.com/v1/', credentialFingerprint: 'a'.repeat(64) }
  outbox.stageAdmission(scope, runId, admission)
  outbox.stageAdmission(scope, runId, { ...admission, requestId: secondRequest, hostRequestId: `host-${crypto.randomUUID()}` })
  const receipt = { productSpaceId: scope.productSpaceId, runId, requestId: secondRequest, inputTokens: 1, outputTokens: 2, outputDisposition: 'usable' as const, providerObservation: { version: 1 as const, state: 'missing' as const } }
  outbox.stageReceipt(scope, receipt)
  const reads: unknown[] = [], posts: unknown[] = []
  let confirmed = false
  const coordinator = new LocalAppRuntimeCoordinator({ billingOutbox: new AppBillingOutbox(directory), admin: {
    startAppRun: async () => { throw new Error('Recovery must never create a task') },
    admitAppRequest: async () => { throw new Error('Recovery must never create a provider admission') },
    getAppRequest: async (run, request, options) => { reads.push({ run, request, options }); return { request: { requestId: request, state: 'admitted' }, settlement: 'pending' } },
    recordAppUsage: async (input, options) => { posts.push({ input, options }); return { runId: input.runId, requestId: input.requestId, recorded: confirmed, settlement: confirmed ? 'confirmed' : 'pending' } },
    finishAppRun: async () => { throw new Error('Recovery must not change execution end') },
  }, createExecutor: () => { throw new Error('Recovery must never rerun AI') }, resolveWorkspaceRoot: () => null, loadWorkspaceConfig: () => null, getDefaultLlmConnection: () => null })
  try {
    expect(await coordinator.reconcileBillingOutbox('other-account', scope.adminOrigin)).toBe(0)
    expect(await coordinator.reconcileBillingOutbox(scope.accountId, 'https://other.example.com')).toBe(0)
    expect(reads).toHaveLength(0); expect(posts).toHaveLength(0)
    expect(await coordinator.reconcileBillingOutbox(scope.accountId, scope.adminOrigin)).toBe(0)
    expect(reads).toHaveLength(1); expect(posts).toHaveLength(1)
    expect(reads[0]).toMatchObject({ run: runId, request: firstRequest, options: { accountId: scope.accountId, adminOrigin: scope.adminOrigin } })
    expect(posts[0]).toMatchObject({ input: receipt, options: { accountId: scope.accountId, adminOrigin: scope.adminOrigin } })
    confirmed = true
    expect(await coordinator.reconcileBillingOutbox(scope.accountId, scope.adminOrigin)).toBe(1)
    expect(new AppBillingOutbox(directory).entries(scope.accountId, scope.adminOrigin)).toHaveLength(1)
    expect(posts[1]).toMatchObject({ input: receipt })
  } finally { await coordinator.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})
