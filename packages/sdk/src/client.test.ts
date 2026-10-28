import { afterEach, expect, test } from 'bun:test'
import { polo, PoloError } from './client'
import type { AppSdkHost, PoloResult } from './protocol'
let listeners = new Set<any>(), starts = 0, cancels = 0
const value: PoloResult = { status: 'completed', text: '{"ok":true}', requestId: crypto.randomUUID(), settlement: 'pending' }
function install(overrides: Partial<AppSdkHost> = {}) {
  listeners = new Set(); starts = 0; cancels = 0
  const host: AppSdkHost = {
    info: async () => ({ ok: true, data: { protocolVersion: 1, features: ['single_query', 'cancel', 'status'] } }),
    start: async () => { starts++; return { ok: true, data: value } },
    cancel: async () => { cancels++; return { ok: true, data: { accepted: true } } },
    onStatus: callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, ...overrides,
  }
  Object.assign(globalThis, { poloAppHost: host }); return host
}
afterEach(() => { delete (globalThis as any).poloAppHost })
test('plain browser fails explicitly without a provider fallback', async () => {
  expect(await polo.isAvailable()).toBe(false)
  await expect(polo.prompt({ prompt: 'hello' })).rejects.toMatchObject({ code: 'host_unavailable' })
})
test('unsupported bridge and forbidden identity fields never start', async () => {
  install({ info: async () => ({ ok: true, data: { protocolVersion: 2 } as any }) })
  await expect(polo.prompt({ prompt: 'hello' })).rejects.toMatchObject({ code: 'unsupported_host' })
  install()
  for (const options of [{ prompt: '', accountId: 'foreign' }, { prompt: '你好'.repeat(400000) }, { prompt: 'x', timeoutMs: 1 }, { prompt: 'x', provider: 'owned' }]) await expect(polo.prompt(options as any)).rejects.toBeInstanceOf(PoloError)
  expect(starts).toBe(0)
})
test('validQuery pins the hand-written budget bounds: wire maximum accepted, first byte over rejected', async () => {
  install()
  await expect(polo.prompt({ prompt: 'x', maxOutputTokens: 131_072 })).resolves.toBe(value)
  await expect(polo.prompt({ prompt: 'x', timeoutMs: 3_600_000 })).resolves.toBe(value)
  await expect(polo.prompt({ prompt: 'x', maxOutputTokens: 131_073 })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(polo.prompt({ prompt: 'x', timeoutMs: 3_600_001 })).rejects.toMatchObject({ code: 'invalid_request' })
  expect(starts).toBe(2)
})
test('one query preserves partial/pending and unsubscribes all listeners', async () => {
  install({ start: async id => { starts++; for (const l of listeners) { l({ callId: 'other', phase: 'failed' }); l({ callId: id, phase: 'running' }) } return { ok: true, data: { ...value, status: 'partial' } } } })
  const task = polo.run({ prompt: 'quote' }); const statuses: string[] = []; task.onStatus(s => statuses.push(s.phase))
  expect(await task.result).toMatchObject({ status: 'partial', settlement: 'pending' }); expect(starts).toBe(1)
  expect(statuses).toEqual(['running', 'completed']); expect(listeners.size).toBe(0)
})
test('cancel during handshake never submits a query', async () => {
  let ready!: (v: any) => void
  install({ info: () => new Promise(r => { ready = r }) })
  const task = polo.run({ prompt: 'x' }); await task.cancel(); ready({ ok: true, data: { protocolVersion: 1, features: ['single_query', 'cancel', 'status'] } })
  await expect(task.result).rejects.toMatchObject({ code: 'request_cancelled' }); expect(starts).toBe(0)
})
test('cancel before final ack is sent once; a completed provider outcome is preserved', async () => {
  let finish!: (v: any) => void
  install({ start: async () => { starts++; return new Promise(r => { finish = r }) } })
  const task = polo.run({ prompt: 'x' }); while (!finish) await Bun.sleep(0)
  await task.cancel(); await task.cancel(); expect(cancels).toBe(1)
  finish({ ok: true, data: value }); expect(await task.result).toEqual(value); expect(listeners.size).toBe(0)
})
test('aborted signal never sends, and cancellation waits for Main cleanup result', async () => {
  install(); const controller = new AbortController(); controller.abort()
  await expect(polo.prompt({ prompt: 'x', signal: controller.signal })).rejects.toMatchObject({ code: 'request_cancelled' }); expect(starts).toBe(0)
  let done!: (v: any) => void
  install({ start: () => new Promise(r => { done = r }) })
  const task = polo.run({ prompt: 'x' }); while (!done) await Bun.sleep(0)
  let settled = false; task.result.catch(() => { settled = true }); await task.cancel(); expect(settled).toBe(false)
  done({ ok: false, error: { code: 'metering_unconfirmed' } }); await expect(task.result).rejects.toMatchObject({ code: 'metering_unconfirmed' }); expect(listeners.size).toBe(0)
})
