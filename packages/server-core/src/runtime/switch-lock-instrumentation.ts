/**
 * INTERNAL test seam for the switch lock — NOT exported through the package
 * `exports` map. External package consumers can neither observe the lock
 * queue nor forge any capability through it; only in-package code (the
 * handler tests) reaches this module via relative imports.
 *
 * Purely observational: labels describe queued tasks, they never alter lock
 * behavior or carry any authority.
 */
export interface SwitchLockEvent {
  seq: number
  label: string
}

const log: SwitchLockEvent[] = []
let seq = 0
let pending = 0

export function lockEnqueued(label: string): SwitchLockEvent {
  pending += 1
  const event = { seq: ++seq, label }
  log.push(event)
  return event
}

export function lockSettled(event: SwitchLockEvent): void {
  pending -= 1
  const done = log.findIndex(entry => entry.seq === event.seq)
  if (done !== -1) log.splice(done, 1)
}

export function pendingSwitchLockTasks(): number {
  return pending
}

export function eventLog(): SwitchLockEvent[] {
  return log.map(entry => ({ ...entry }))
}
