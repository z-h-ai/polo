/**
 * INTERNAL switch mutex + test observation seam.
 *
 * This module is deliberately NOT listed in the package `exports` map:
 * only in-package source (relative imports) can reach it. Public package
 * consumers of `./runtime/product-space-executions` get the purpose-scoped
 * mutex runner (`runUnderSwitchMutex`) but never the labeled scheduler or
 * its observation registry.
 *
 * Labels are purely descriptive (observational tokens for tests); they do
 * not alter lock semantics and carry no capability.
 */
export interface SwitchLockEvent {
  seq: number
  label: string
}

const log: SwitchLockEvent[] = []
let seq = 0
let pending = 0

let switchLockTail: Promise<unknown> = Promise.resolve()

/**
 * Production mutex: strictly serializes queued tasks (FIFO). The optional
 * label is observational only.
 */
export async function withSwitchLock<T>(
  operation: () => Promise<T>,
  label = 'unlabeled',
): Promise<T> {
  const previous = switchLockTail
  let release!: () => void
  switchLockTail = new Promise<void>(resolve => {
    release = resolve
  })
  pending += 1
  const event = { seq: ++seq, label }
  log.push(event)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    pending -= 1
    const done = log.findIndex(entry => entry.seq === event.seq)
    if (done !== -1) log.splice(done, 1)
    release()
  }
}

/** Test-observable queue depth (waiting + running). */
export function pendingSwitchLockTasks(): number {
  return pending
}

/** Test-observable enqueue/settle token registry (drains on settle). */
export function switchLockEventLog(): SwitchLockEvent[] {
  return log.map(entry => ({ ...entry }))
}
