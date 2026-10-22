import { expect, it } from 'bun:test'
import { PromptTurnContexts } from './prompt-turn-context.ts'
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
it('queued followUp retains original prompt context, and detached completed A cannot borrow B', async () => {
  const turns = new PromptTurnContexts(), release = deferred(), entered = deferred(), events: string[] = []
  let old!: ReturnType<PromptTurnContexts['capture']>
  const a = turns.run(A, async () => { old = turns.capture(); events.push(old.turnId); entered.resolve(); await release.promise; turns.assert(old); return 'A' })
  await entered.promise
  const b = turns.run(B, async () => { events.push(turns.capture().turnId); expect(() => turns.assert(old)).toThrow('ended'); return 'B' })
  await Promise.resolve(); expect(events).toEqual([A]); release.resolve()
  expect(await a).toBe('A'); expect(await b).toBe('B'); expect(events).toEqual([A, B]); expect(() => turns.capture()).toThrow('no original')
})
it('abort before delayed approval forbids native execute even if response allows, including queued prompt', async () => {
  const turns = new PromptTurnContexts(), approved = deferred(), entered = deferred(); let executed = 0
  const a = turns.run(A, async () => { const original = turns.capture(); entered.resolve(); await approved.promise; turns.assert(original); executed++ })
  await entered.promise; const b = turns.run(B, async () => { executed++ }); turns.abort(); approved.resolve()
  const results = await Promise.allSettled([a, b]); expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']); expect(executed).toBe(0)
  await turns.run(B, async () => { const original = turns.capture(); const abort = new AbortController(); abort.abort(); expect(() => turns.assert(original, abort.signal)).toThrow('aborted') })
})
it('invalid producer UUID cannot enter SDK operation', async () => { const turns = new PromptTurnContexts(); let called = false; await expect(turns.run('turn-1', async () => { called = true })).rejects.toThrow('identity'); expect(called).toBe(false) })
it('B waits for both original A prompt settlement and its original SDK abort drain; late A abort leaves B alone', async () => {
  const turns = new PromptTurnContexts(), entered = deferred(), promptEnd = deferred(), abortEnd = deferred(), bEnd = deferred(), bEntered = deferred()
  const a = turns.run(A, async () => { entered.resolve(); await promptEnd.promise })
  await entered.promise
  let aborts = 0
  const abort = turns.abortAndDrain(A, async () => { aborts++; await abortEnd.promise })
  const b = turns.run(B, async () => { bEntered.resolve(); await bEnd.promise; turns.assert(turns.capture()) })
  promptEnd.resolve(); await a; await Promise.resolve(); let admitted = false; bEntered.promise.then(() => { admitted = true }); await Promise.resolve(); expect(admitted).toBe(false)
  abortEnd.resolve(); await abort; await bEntered.promise
  await turns.abortAndDrain(A, async () => { aborts++ }); expect(aborts).toBe(1)
  bEnd.resolve(); await b
})
