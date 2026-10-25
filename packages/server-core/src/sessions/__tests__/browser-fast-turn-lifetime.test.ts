import { expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'

test('browser request lifetime ends with its turn and cannot revive in the next turn', () => {
  const manager = new SessionManager() as any
  const managed: any = { isProcessing: false }
  manager.setProcessing(managed, true)
  const first = managed.browserFastAbortController.signal as AbortSignal
  manager.setProcessing(managed, true)
  expect(managed.browserFastAbortController.signal).toBe(first)
  expect(first.aborted).toBeFalse()
  manager.setProcessing(managed, false)
  expect(first.aborted).toBeTrue()
  manager.setProcessing(managed, true)
  expect(managed.browserFastAbortController.signal).not.toBe(first)
  expect(managed.browserFastAbortController.signal.aborted).toBeFalse()
  expect(first.aborted).toBeTrue()
  manager.setProcessing(managed, false)
})

test('user stop aborts host browser requests before awaited durable cleanup', async () => {
  const manager = new SessionManager() as any
  // A question handoff may already be idle; outstanding host requests must
  // still stop before the idle early-return, even when persistence is slow.
  const controller = new AbortController()
  const managed = { id: 'stopped-browser', isProcessing: false, browserFastAbortController: controller }
  manager.sessions.set(managed.id, managed)
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  manager.clearPendingQuestionForSession = () => barrier
  manager.clearPendingAgentResume = async () => {}
  const stopped = manager.cancelProcessing(managed.id)
  expect(controller.signal.aborted).toBeTrue()
  release()
  await stopped
})

test('refresh disposes old browser work without cancelling the committed successor turn', async () => {
  const manager = new SessionManager() as any
  let disposed = 0
  const managed: any = { id: 'refresh-browser', isProcessing: false, processingGeneration: 3,
    browserFastDecider: { async dispose() { disposed++ } } }
  manager.sessions.set(managed.id, managed)
  manager.setProcessing(managed, true)
  const turn = managed.browserFastAbortController.signal
  await manager.disposeManagedAgentRuntime(managed, 'send-path refresh')
  expect(disposed).toBe(1)
  expect(turn.aborted).toBeFalse()
  expect(managed.browserFastDecider).toBeUndefined()
  expect(managed.processingGeneration).toBe(3)
  manager.setProcessing(managed, false)
})

test('app cleanup aborts turns and waits for original browser billing cleanup', async () => {
  const manager = new SessionManager() as any
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  const controller = new AbortController()
  manager.sessions.set('shutdown-browser', { id: 'shutdown-browser', browserFastAbortController: controller,
    browserFastDecider: { dispose: () => barrier } })
  let cleaned = false
  const cleanup = manager.cleanup().then(() => { cleaned = true })
  expect(controller.signal.aborted).toBeTrue()
  await Bun.sleep(10)
  expect(cleaned).toBeFalse()
  release(); await cleanup
  expect(cleaned).toBeTrue()
})

test('shutdown also drains removed session owners after best-effort disposal times out', async () => {
  const manager = new SessionManager() as any
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  const original = manager.ownBrowserFastDecider({ dispose: () => barrier })
  const managed = { id: 'deleted-browser', browserFastDecider: original }
  manager.sessions.set(managed.id, managed)
  manager.sessions.delete(managed.id)
  // Exercise the production best-effort branch with a deterministic timeout,
  // leaving the ORIGINAL disposal promise outstanding until shutdown drains it.
  manager.boundedRuntimeDisposal = async (_id: string, _kind: string, operation: () => Promise<unknown>, failures: string[]) => {
    failures.push('browser timeout')
    return { status: 'timeout', original: operation() }
  }
  await manager.disposeManagedAgentRuntime(managed, 'delete', { bestEffort: true })
  expect(manager.browserFastDeciders.has(original)).toBeTrue()
  let cleaned = false
  const cleanup = manager.cleanup().then(() => { cleaned = true })
  await Bun.sleep(10)
  expect(cleaned).toBeFalse()
  release(); await cleanup
  expect(manager.browserFastDeciders.size).toBe(0)
})
