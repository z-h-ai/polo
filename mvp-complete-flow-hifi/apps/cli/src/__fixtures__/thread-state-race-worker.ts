import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireCliThreadLease,
  deleteCliThread,
  locateCliThread,
} from '../cli-thread-store.ts'

const [root, threadId, barrierRoot, action, workerId] = process.argv.slice(2)
if (!root || !threadId || !barrierRoot || !action || !workerId) {
  throw new Error(
    'usage: thread-state-race-worker <root> <thread-id> <barrier> <acquire|delete> <id>',
  )
}
process.env.POLO_AI_CONFIG_DIR = root

const record = await locateCliThread(threadId)
if (!record) throw new Error(`thread not found: ${threadId}`)
await writeFile(join(barrierRoot, `${workerId}.ready`), '')
const startFile = join(barrierRoot, 'start')
const deadline = Date.now() + 10_000
while (!existsSync(startFile)) {
  if (Date.now() >= deadline) throw new Error('state race barrier timed out')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}

try {
  if (action === 'acquire') {
    await acquireCliThreadLease(record)
    // Keep the process identity alive long enough for a delayed delete
    // contender to observe a genuinely active owner.
    await Bun.sleep(100)
  } else if (action === 'delete') {
    await deleteCliThread(record)
  } else {
    throw new Error(`unknown action: ${action}`)
  }
  process.stdout.write(`${JSON.stringify({ action, status: 'succeeded' })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    action,
    status: 'rejected',
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
}
