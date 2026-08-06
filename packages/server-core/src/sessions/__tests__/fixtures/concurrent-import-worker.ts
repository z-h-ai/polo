import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  RootedSessionStorage,
  type SessionBundle,
} from '@polo-ai/shared/sessions'
import { SessionManager } from '../../SessionManager.ts'

const [root, mode, workerId] = process.argv.slice(2)
if (!root || (mode !== 'fork' && mode !== 'move') || !workerId) {
  throw new Error('usage: concurrent-import-worker <root> <fork|move> <worker-id>')
}

const barrierRoot = join(root, 'barrier')
mkdirSync(barrierRoot, { recursive: true })
const originalGetRandomValues = crypto.getRandomValues.bind(crypto)
Object.defineProperty(crypto, 'getRandomValues', {
  configurable: true,
  value: <T extends ArrayBufferView>(array: T): T => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0)
    return array
  },
})

class BarrierSessionStorage extends RootedSessionStorage {
  private firstReservation = true

  override reserveSession(workspaceRootPath: string, sessionId: string): string {
    if (this.firstReservation) {
      this.firstReservation = false
      Object.defineProperty(crypto, 'getRandomValues', {
        configurable: true,
        value: originalGetRandomValues,
      })
      writeFileSync(join(barrierRoot, `${workerId}.ready`), sessionId)
      const other = workerId === 'one' ? 'two' : 'one'
      const deadline = Date.now() + 5_000
      while (!existsSync(join(barrierRoot, `${other}.ready`))) {
        if (Date.now() >= deadline) throw new Error('reservation barrier timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    return super.reserveSession(workspaceRootPath, sessionId)
  }
}

const workspace = {
  id: 'workspace-1',
  name: 'Workspace 1',
  slug: 'workspace-1',
  rootPath: join(root, 'configuration-workspace'),
  createdAt: 1,
}
mkdirSync(workspace.rootPath, { recursive: true })
const storage = new BarrierSessionStorage(join(root, 'sessions'))
const manager = new SessionManager({
  profile: 'cli-one-shot',
  workspace,
  sessionStorage: storage,
})
const bundle: SessionBundle = {
  version: 1,
  session: {
    header: {
      id: 'shared-move-id',
      workspaceRootPath: workspace.rootPath,
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    },
    messages: [],
  },
  files: [],
}

try {
  const result = await manager.importSession(workspace.id, bundle, mode)
  process.stdout.write(`${result.sessionId}\n`)
} finally {
  manager.cleanup()
}
