import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { RootedSessionStorage } from '@polo-ai/shared/sessions/session-storage.ts'
import { resetProductSpaceExecutionRegistryForTests, setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } from '../runtime/product-space-executions'
import { setSyncTrustedProductSpaceAccountId } from '../handlers/rpc/trusted-product-space-account'

let root: string
let sm: SessionManager
let internal: any
let workspace: any
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sm-task-pubsub-'))
  workspace = { id: 'ws_test', name: 'Test', rootPath: root, createdAt: 0 }
  sm = new SessionManager({ workspace, sessionStorage: new RootedSessionStorage(join(root, 'sessions')) })
  internal = sm as any
  resetProductSpaceExecutionRegistryForTests()
  setSyncTrustedProductSpaceAccountId('account-a')
  setRuntimeActiveProductSpaceAccount('account-a')
  setRuntimeActiveProductSpace('space-a')
})
afterEach(() => {
  for (const m of internal.taskSubscriptionManagers.values()) m.dispose()
  rmSync(root, { recursive: true, force: true })
  resetProductSpaceExecutionRegistryForTests()
})
function session(id: string, accountId = 'account-a') {
  const m = createManagedSession({ id, accountId, productSpaceId: 'space-a' } as never, workspace, { messagesLoaded: true })
  internal.sessions.set(id, m)
  return m
}
function hub() { return sm.getTaskSubscriptionManager(root, workspace.id) }
function callbacks(m: unknown) { return internal.buildManagedSessionToolCallbacks(m) }
async function settle() { await Bun.sleep(30) }

test('workspace subscription listing hides other account instructions', async () => {
  const main = session('main'); session('worker'); session('foreign', 'account-b')
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'foreign', instruction: 'private' })
  const result = await callbacks(main).listTaskSubscriptionsFn('all')
  expect(result.subscriptions).toHaveLength(1)
});

test('delivery refuses persisted cross-account subscriptions', async () => {
  session('worker'); session('foreign', 'account-b')
  let sends = 0
  internal.sendMessage = async () => { sends++ }
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'foreign' })
  expect(await hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'completed' }))).toBe(0)
  expect(sends).toBe(0)
});

test('subscribe to an already closed target wakes just the new listener', async () => {
  const main = session('main'); const worker = session('worker'); session('other')
  worker.sessionStatus = 'done'
  const sends: string[] = []
  internal.sendMessage = async (id: string, _message: string, _a: unknown, _b: unknown, _opts: unknown, _existing: unknown, _retry: unknown, ack: () => void) => { sends.push(id); ack?.() }
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'other', mode: 'persistent' })
  expect((await callbacks(main).subscribeTaskFn({ targetSessionId: 'worker' })).ok).toBe(true)
  await settle()
  expect(sends).toEqual(['main'])
});

test('wake-up completes on durable acceptance without waiting for the model turn', async () => {
  session('main'); session('worker')
  let finish!: () => void
  const modelTurn = new Promise<void>(resolve => { finish = resolve })
  internal.sendMessage = async (_id: string, _message: string, _a: unknown, _b: unknown, _opts: unknown, _existing: unknown, _retry: unknown, ack: () => void) => { ack?.(); await modelTurn }
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  const delivery = hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'completed' }))
  const result = await Promise.race([delivery, Bun.sleep(50).then(() => 'blocked')])
  finish()
  await delivery
  expect(result).toBe(1)
});

test('real sendMessage queues wake-ups without steering the current turn', async () => {
  const main = session('main'); session('worker')
  main.isProcessing = true
  let redirects = 0
  main.agent = { redirect: () => { redirects++; return true } } as never
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  expect(await hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'completed' }))).toBe(1)
  expect(redirects).toBe(0)
  expect(main.messageQueue).toHaveLength(1)
  expect(main.messages[0]?.content).toContain('[Task event] completed')
});

test('accepted wake-up is persisted with the queue flag used by restart recovery', async () => {
  const main = session('main'); session('worker')
  main.isProcessing = true
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  await hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'completed' }))
  const stored = internal.sessionStorage.load(root, 'main')
  expect(stored.messages[0].isQueued).toBe(true)
  // Exercise the actual cold-message recovery path in a fresh SessionManager.
  const restored = new SessionManager({ workspace, sessionStorage: internal.sessionStorage }) as any
  const cold = createManagedSession({ id: 'main' } as never, workspace)
  restored.sessions.set('main', cold)
  restored.processNextQueuedMessage = () => {}
  restored.hydrateMessagesForColdPersist(cold)
  expect(cold.messageQueue).toHaveLength(1)
});

test('reopening a target before subscribing does not replay its previous completion', async () => {
  const main = session('main'); const worker = session('worker')
  await hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'completed', toStatus: 'done', emittedBy: 'system' }))
  let sends = 0
  internal.sendMessage = async (_id: string, _message: string, _a: unknown, _b: unknown, _opts: unknown, _existing: unknown, _retry: unknown, ack: () => void) => { sends++; ack?.() }
  worker.sessionStatus = 'in-progress'
  const reopened = hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'status_changed', fromStatus: 'done', toStatus: 'in-progress' }))
  await callbacks(main).subscribeTaskFn({ targetSessionId: 'worker' })
  await reopened
  await settle()
  expect(sends).toBe(0)
  expect(hub().list('main')).toHaveLength(1)
});

test('YAML replays completed upstream once and stays consumed across restart', async () => {
  const worker = session('worker'); session('main')
  worker.sessionStatus = 'done'
  let sends = 0
  internal.sendMessage = async (_id: string, _message: string, _a: unknown, _b: unknown, _opts: unknown, _existing: unknown, _retry: unknown, ack: () => void) => { sends++; ack?.() }
  mkdirSync(join(root, 'task-events/chains'), { recursive: true })
  writeFileSync(join(root, 'task-events/chains/test.yaml'), 'chain: c\nsteps:\n  - {id: a, session: worker}\n  - {id: b, session: main, after: a}')
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  await settle()
  expect(sends).toBe(1)
  hub().dispose()
  internal.taskSubscriptionManagers.clear()
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  await settle()
  expect(sends).toBe(1)
  expect(hub().list()).toHaveLength(0)
});

test('external status metadata changes publish task events', async () => {
  session('main'); const worker = session('worker')
  internal.persistSession = () => {}
  internal.sendEvent = () => {}
  const messages: string[] = []
  internal.sendMessage = async (_id: string, text: string, _a: unknown, _b: unknown, _opts: unknown, _existing: unknown, _retry: unknown, ack: () => void) => { messages.push(text); ack?.() }
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  internal.applyExternalSessionMetadata(worker, { sessionStatus: 'done' })
  await settle()
  expect(messages).toHaveLength(1)
});

test('session deletion prunes listeners for target and subscriber', async () => {
  const worker = session('worker'); session('main')
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  await internal.declareSessionDeletedLocked(worker)
  expect(hub().list()).toHaveLength(0)
});

test('chain with a cross-account edge is entirely rejected', () => {
  session('worker'); session('main'); session('foreign', 'account-b')
  mkdirSync(join(root, 'task-events/chains'), { recursive: true })
  writeFileSync(join(root, 'task-events/chains/test.yaml'), 'chain: c\nsteps:\n  - {id: a, session: worker}\n  - {id: b, session: main, after: a}\n  - {id: c, session: foreign, after: b}')
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  expect(hub().list()).toHaveLength(0)
});

test('initialize restores sessions before resolving chain references', async () => {
  // Keep real initialize ordering, stub unrelated auth/config services.
  internal.runtimeProfile = 'cli-one-shot'
  internal.cliAuthority = null
  internal.setupConfigWatcher = () => {}
  internal.loadSessionsFromDisk = () => { session('worker'); session('main') }
  internal.runtimeProfile = 'default'
  internal.reinitializeAuth = async () => {}
  mkdirSync(join(root, 'task-events/chains'), { recursive: true })
  writeFileSync(join(root, 'task-events/chains/test.yaml'), 'chain: c\nsteps:\n  - {id: a, session: worker}\n  - {id: b, session: main, after: a}')
  await sm.initialize()
  expect(hub().list()).toHaveLength(1)
});

test('initialize autonomously recovers an acknowledged queued wake-up', async () => {
  const main = session('main'); session('worker')
  main.isProcessing = true
  hub().subscribe({ targetSessionId: 'worker', subscriberSessionId: 'main' })
  await hub().handleTaskEvent(hub().buildEvent({ sessionId: 'worker', type: 'completed' }))
  hub().dispose()
  const restored = new SessionManager({ workspace, sessionStorage: internal.sessionStorage }) as any
  restored.reinitializeAuth = async () => {}
  restored.setupConfigWatcher = () => {}
  let sends = 0
  restored.sendMessage = async (id: string, text: string) => { if (id === 'main' && text.startsWith('[Task event]')) sends++ }
  await restored.initialize()
  const deadline = Date.now() + 2500
  while (!sends && Date.now() < deadline) await Bun.sleep(25)
  for (const m of restored.taskSubscriptionManagers.values()) m.dispose()
  expect(sends).toBe(1)
});

test('YAML refuses stale terminal downstream steps rather than skipping dependencies', async () => {
  const a = session('a'); const b = session('b'); session('c')
  a.sessionStatus = 'done'; b.sessionStatus = 'done'
  let sends = 0
  internal.sendMessage = async (_id: string, _text: string, _a: unknown, _b: unknown, _opts: unknown, _existing: unknown, _retry: unknown, ack: () => void) => { sends++; ack?.() }
  mkdirSync(join(root, 'task-events/chains'), { recursive: true })
  writeFileSync(join(root, 'task-events/chains/new.yaml'), 'chain: new\nsteps:\n  - {id: a, session: a}\n  - {id: b, session: b, after: a}\n  - {id: c, session: c, after: b}')
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  await settle()
  expect(hub().list()).toHaveLength(0)
  expect(sends).toBe(0)
});

test('YAML edit replaces old instruction and file removal disarms its edges', () => {
  session('worker'); session('main')
  mkdirSync(join(root, 'task-events/chains'), { recursive: true })
  const file = join(root, 'task-events/chains/test.yaml')
  const yaml = 'chain: c\nsteps:\n  - {id: a, session: worker}\n  - {id: b, session: main, after: a, prompt: OLD}'
  writeFileSync(file, yaml)
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  writeFileSync(file, yaml.replace('OLD', 'REVIEW ONLY'))
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  expect(hub().list().map(s => s.instruction)).toEqual(['REVIEW ONLY'])
  rmSync(file)
  sm.loadTaskChainsForWorkspace(root, workspace.id)
  expect(hub().list()).toHaveLength(0)
});
