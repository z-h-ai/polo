import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { AssistantBillingCoordinator, type AssistantBillingTransport } from '../assistant-billing'
import { AssistantBillingCapability } from '../assistant-billing-capability'

const facts = () => ({ model: 'owned-model', hostRequestId: `host-${randomUUID()}`, transportBaseUrl: 'https://provider.invalid/v1', credentialFingerprint: 'a'.repeat(64) })
const unused = async () => { throw new Error('unexpected write') }
function setup(transport: Partial<AssistantBillingTransport> & { capabilities?: (scope: AssistantBillingJournalScope) => Promise<{ preparation: boolean; recovery: boolean }> }) {
  const dir = mkdtempSync(join(tmpdir(), 'poo194-prepare-'))
  const scope: AssistantBillingJournalScope = { subjectKind: 'polo_assistant', accountId: randomUUID(), productSpaceId: randomUUID(), adminOrigin: 'https://admin.invalid' }
  const outbox = new BillingOutbox<AssistantBillingJournalScope>(dir)
  const admittedOutbox = new BillingOutbox<AssistantBillingJournalScope>(join(dir, 'admitted'))
  const getTransport = () => ({ start: unused, admit: unused, report: unused, inspect: unused, finish: unused, ...transport })
  const coordinator = Reflect.construct(AssistantBillingCoordinator, [outbox, getTransport, admittedOutbox]) as AssistantBillingCoordinator
  return { dir, scope, outbox, admittedOutbox, coordinator, getTransport, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('server recovery journals only after a validated preparation and before returning the ticket', async () => {
  const f = setup({ capabilities: async () => ({ preparation: true, recovery: true }), prepare: async (_, runId, input) => {
    expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
    expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
    return ack(runId, input.requestId)
  } })
  try {
    await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
    expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
    expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(1)
  } finally { f.close() }
})
for (const failure of ['lost', 'wrong_identity', 'denied'] as const) {
  test(`server-owned ${failure} preparation leaves no uncreated local intent`, async () => {
    const f = setup({ capabilities: async () => ({ preparation: true, recovery: true }),
      prepare: async (_, runId, input) => {
        if (failure === 'wrong_identity') return ack(randomUUID(), input.requestId)
        throw new AdminError(failure, failure === 'lost' ? 'TIMEOUT' : 'insufficient_credit', { status: failure === 'lost' ? 408 : 409 })
      }, finish: async (_, runId) => ({ runId, status: 'failed', settlement: 'no_charge' }),
    })
    try {
      await expect(f.coordinator.hooks(f.scope, () => true).beforeSend(facts())).rejects.toThrow()
      expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
      expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
    } finally { f.close() }
  })
}
test('an interface-only Admin keeps the original pre-stage protocol', async () => {
  const f = setup({ capabilities: async () => ({ preparation: true, recovery: false }), prepare: async (_, runId, input) => {
    expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(1)
    expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
    return ack(runId, input.requestId)
  } })
  try { await f.coordinator.hooks(f.scope, () => true).beforeSend(facts()) } finally { f.close() }
})
test('post-ack journal failure cannot return a provider send ticket', async () => {
  let preparations = 0
  const f = setup({ capabilities: async () => ({ preparation: true, recovery: true }), prepare: async (_, runId, input) => { preparations++; return ack(runId, input.requestId) }, finish: async (_, runId) => ({ runId, status: 'failed', settlement: 'no_charge' }) })
  f.admittedOutbox.stageAdmission = () => { throw new Error('ENOSPC') }
  try {
    await expect(f.coordinator.hooks(f.scope, () => true).beforeSend(facts())).rejects.toThrow('ENOSPC')
    expect(preparations).toBe(1)
  } finally { f.close() }
})
test('4096 retained legacy evidence files cannot fill the new admitted queue', async () => {
  let recovery = false, preparations = 0
  const f = setup({ capabilities: async () => ({ preparation: true, recovery }), prepare: async (_, runId, input) => { preparations++; return ack(runId, input.requestId) } })
  try {
    // Unknown historical files are deliberately preserved, not fabricated as
    // zero-cost settlements or removed to make the capacity check pass.
    for (let i = 0; i < 4096; i++) writeFileSync(join(f.dir, `${i.toString(16).padStart(64, '0')}.json`), '{"historical":"retain"}')
    await expect(f.coordinator.hooks(f.scope, () => true).beforeSend(facts())).rejects.toThrow('capacity')
    expect(preparations).toBe(0)
    recovery = true
    await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
    expect(preparations).toBe(1)
    expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(1)
    expect(readdirSync(f.dir).filter(name => name.endsWith('.json'))).toHaveLength(4096)
  } finally { f.close() }
})
test('a second coordinator cannot delete another sender admission while it is pending', async () => {
  let reports = 0
  const f = setup({ capabilities: async () => ({ preparation: true, recovery: true }), prepare: async (_, runId, input) => ack(runId, input.requestId),
    inspect: async () => ({ settlement: 'pending' }), report: async () => { reports++; return { settlement: 'confirmed' } }, finish: async () => {},
  })
  try {
    const ticket = await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
    const second = Reflect.construct(AssistantBillingCoordinator, [f.outbox, f.getTransport, f.admittedOutbox]) as AssistantBillingCoordinator
    await second.recover(f.scope.accountId, f.scope.adminOrigin)
    expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(1)
    await ticket.complete({ inputTokens: 3, outputTokens: 2, actualModel: 'owned-model', outputDisposition: 'usable', provenance: 'provider_final' })
    expect(reports).toBe(1)
    expect(f.admittedOutbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
  } finally { f.close() }
})
function ack(runId: string, requestId: string) { return { runId, request: { requestId, state: 'admitted', providerCorrelation: { nonce: 'a'.repeat(32), header: 'X-Polo-Request-Id' } }, idempotent: false } }

test('two model rounds each prepare once with independent durable identities', async () => {
  const ids: string[] = []
  const f = setup({ prepare: async (_, runId, input) => { ids.push(runId, input.requestId); expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(ids.length / 2); return ack(runId, input.requestId) } })
  try {
    await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
    await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
    expect(new Set(ids).size).toBe(4)
  } finally { f.close() }
})
for (const mode of ['known_start_denial', 'admission_denial', 'wrong_identity', 'lost'] as const) {
  test(`prepare failure keeps the correct recovery identity: ${mode}`, async () => {
    let finishes = 0
    const f = setup({
      prepare: async (_, runId, input) => {
        if (mode === 'lost') throw new AdminError('lost acknowledgement', 'TIMEOUT')
        throw new AdminError('denied', 'insufficient_credit', { status: 409, details: mode === 'admission_denial' ? undefined : { assistantPreparation: { runId: mode === 'wrong_identity' ? randomUUID() : runId, requestId: input.requestId, phase: 'start_rejected' } } })
      },
      finish: async () => { finishes++; throw new AdminError('unknown', 'NOT_FOUND', { status: 404 }) },
    })
    try {
      await expect(f.coordinator.hooks(f.scope, () => true).beforeSend(facts())).rejects.toThrow()
      expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(mode === 'known_start_denial' ? 0 : 1)
      expect(finishes).toBe(mode === 'known_start_denial' ? 0 : 1)
    } finally { f.close() }
  })
}
test('scope changes during prepare prevent a send ticket and finish the original run', async () => {
  let current = true, finished = ''
  const f = setup({ prepare: async (_, runId, input) => { current = false; return ack(runId, input.requestId) }, finish: async (scope, runId) => { expect(scope).toEqual(f.scope); finished = runId; return { runId, status: 'failed', settlement: 'no_charge' } } })
  try {
    await expect(f.coordinator.hooks(f.scope, () => current).beforeSend(facts())).rejects.toThrow('scope changed')
    expect(finished).not.toBe(''); expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
  } finally { f.close() }
})
test('a failed capability probe never creates an intent or starts billing', async () => {
  const f = setup({ supportsPreparation: async () => { throw new Error('probe offline') }, prepare: unused })
  try {
    await expect(f.coordinator.hooks(f.scope, () => true).beforeSend(facts())).rejects.toThrow('probe offline')
    expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(0)
  } finally { f.close() }
})
for (const state of ['timed_out', 'pending', 'wrong_space', 'missing'] as const) {
  test(`recovery reads the worker's original terminal fact: ${state}`, async () => {
    const f = setup({
      inspect: async () => { throw new AdminError('missing request', 'NOT_FOUND', { status: 404 }) },
      finish: async () => { throw new AdminError('already closed', 'run_finalized', { status: 409 }) },
      inspectRun: async (_, runId) => {
        if (state === 'missing') throw new AdminError('missing run', 'NOT_FOUND', { status: 404 })
        return { run: { runId, productSpaceId: state === 'wrong_space' ? randomUUID() : f.scope.productSpaceId, status: state === 'pending' ? 'running' : 'timed_out' }, settlement: state === 'pending' ? 'pending' : 'no_charge' }
      },
    })
    try {
      f.outbox.stageAdmission(f.scope, randomUUID(), { ...facts(), productSpaceId: f.scope.productSpaceId, requestId: randomUUID() })
      await f.coordinator.recover(f.scope.accountId, f.scope.adminOrigin)
      expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(state === 'timed_out' ? 0 : 1)
    } finally { f.close() }
  })
}
test('capability reuse is bounded, scoped and does not retain failed discovery', async () => {
  let now = 0, calls = 0
  const cache = new AssistantBillingCapability(() => now)
  const scope = { accountId: 'a', productSpaceId: 's', adminOrigin: 'https://a.invalid' }
  const probe = async () => { calls++; return true }
  await Promise.all([cache.read(scope, probe), cache.read(scope, probe)])
  expect(calls).toBe(1)
  now = 60_000; await cache.read(scope, probe); expect(calls).toBe(2)
  await cache.read({ ...scope, accountId: 'b' }, probe); expect(calls).toBe(3)
  await expect(cache.read(scope, async () => { throw new Error('offline') })).rejects.toThrow()
  await cache.read(scope, probe); expect(calls).toBe(4)
  cache.invalidate({ ...scope, accountId: 'old' }); await cache.read(scope, probe); expect(calls).toBe(4)
  cache.invalidate(scope); await cache.read(scope, probe); expect(calls).toBe(5)
})

for (const supports of [true, false]) {
  test(`real HTTP AdminClient path count, capability ${supports}`, async () => {
    const calls: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname; calls.push(`${request.method} ${path}`)
      if (path === '/api/auth/config') return Response.json({ phoneAuthEnabled: false, selfRegistrationEnabled: false, ...(supports ? { assistantPreparationVersion: 1 } : {}) })
      const body = await request.json() as any
      if (path === '/api/billing/assistant-requests') return Response.json(ack(body.runId, body.admission.requestId))
      if (path === '/api/billing/runs') return Response.json({ run: { runId: body.runId, status: 'running' }, idempotent: false })
      if (path.endsWith('/requests')) { const result = ack('', body.requestId); return Response.json({ request: result.request, idempotent: false }) }
      return new Response('unexpected', { status: 500 })
    } })
    const client = new AdminClient(`http://127.0.0.1:${server.port}`), cache = new AssistantBillingCapability()
    const f = setup({
      supportsPreparation: scope => cache.read(scope, () => client.supportsAssistantPreparation()),
      prepare: (_, runId, admission) => client.prepareAssistantRequest('fixture', { runId, admission }),
      start: (_, input) => client.startAssistantRun('fixture', input),
      admit: (_, runId, input) => client.admitAppRequest('fixture', runId, input),
    })
    try {
      await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
      const cold = calls.length
      await f.coordinator.hooks(f.scope, () => true).beforeSend(facts())
      expect(cold).toBe(supports ? 2 : 3)
      expect(calls.length - cold).toBe(supports ? 1 : 2)
      expect(calls.filter(p => p === 'POST /api/billing/assistant-requests')).toHaveLength(supports ? 2 : 0)
    } finally { f.close(); await server.stop(true) }
  })
}

for (const receipt of [false, true]) {
  for (const matches of [false, true]) {
    test(`worker terminal recovery with existing request: receipt=${receipt} matching=${matches}`, async () => {
      const expected = receipt ? 'confirmed' : 'no_charge'
      const f = setup({
        report: async () => ({ settlement: 'confirmed' }),
        inspect: async () => ({ settlement: 'no_charge' }),
        finish: async () => { throw new AdminError('worker already finished', 'run_finalized', { status: 409 }) },
        inspectRun: async (_, runId) => ({ run: { runId, productSpaceId: f.scope.productSpaceId, status: 'timed_out' }, settlement: matches ? expected : expected === 'confirmed' ? 'no_charge' : 'confirmed' }),
      })
      try {
        const runId = randomUUID(), requestId = randomUUID()
        f.outbox.stageAdmission(f.scope, runId, { ...facts(), productSpaceId: f.scope.productSpaceId, requestId })
        if (receipt) f.outbox.stageReceipt(f.scope, { runId, requestId, productSpaceId: f.scope.productSpaceId, inputTokens: 1, outputTokens: 1, outputDisposition: 'usable' })
        await f.coordinator.recover(f.scope.accountId, f.scope.adminOrigin)
        expect(f.outbox.entries(f.scope.accountId, f.scope.adminOrigin)).toHaveLength(matches ? 0 : 1)
      } finally { f.close() }
    })
  }
}
