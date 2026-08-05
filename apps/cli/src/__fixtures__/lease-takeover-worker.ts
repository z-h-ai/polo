import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireCliThreadLease,
  locateCliThread,
} from '../cli-thread-store.ts'

const [root, threadId, barrierRoot, workerId] = process.argv.slice(2)
if (!root || !threadId || !barrierRoot || !workerId) {
  throw new Error('usage: lease-takeover-worker <root> <thread-id> <barrier> <worker-id>')
}
process.env.POLO_AI_CONFIG_DIR = root

const record = await locateCliThread(threadId)
if (!record) throw new Error(`thread not found: ${threadId}`)
await writeFile(join(barrierRoot, `${workerId}.ready`), '')
const startFile = join(barrierRoot, 'start')
const deadline = Date.now() + 10_000
while (!existsSync(startFile)) {
  if (Date.now() >= deadline) throw new Error('takeover barrier timed out')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}

try {
  const lease = await acquireCliThreadLease(record)
  process.stdout.write(`${JSON.stringify({
    status: 'acquired',
    leaseId: lease.owner.leaseId,
  })}\n`)
  // Leave a fresh owner behind after process exit. Late contenders must still
  // reject it rather than serially succeeding after the winner exits.
  await Bun.sleep(100)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'rejected',
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
}
