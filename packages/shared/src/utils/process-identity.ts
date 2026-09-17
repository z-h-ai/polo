import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Return a stable, OS-observed birth marker for a currently running process.
 * A PID alone is deliberately not accepted as an identity because PIDs are
 * reused after process exit.
 *
 * The OS query is wrapped in a BOUNDED RETRY: under heavy parallel test/load
 * pressure the `ps` subprocess can transiently fail (non-zero exit, spawn
 * hiccup) even though the target process is alive — a single miss would
 * misclassify a live process as ownerless and silently skip cleanup work.
 * The marker itself is stable for the process's lifetime, so re-querying is
 * always safe.
 */
export function getProcessBirthIdentity(pid: number): string | null {
  if (!isProcessAlive(pid)) return null
  for (let attempt = 0; attempt < 3; attempt++) {
    let marker: string | null = null
    try {
      if (process.platform === 'linux') {
        const statText = readFileSync(`/proc/${pid}/stat`, 'utf-8')
        const endOfCommand = statText.lastIndexOf(')')
        if (endOfCommand < 0) marker = null
        else {
          const fieldsAfterCommand = statText.slice(endOfCommand + 2).trim().split(/\s+/)
          const startTicks = fieldsAfterCommand[19]
          marker = startTicks ? `linux-proc-start:${startTicks}` : null
        }
      } else {
        const command = process.platform === 'win32'
          ? [
              'powershell',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
            ]
          : ['ps', '-o', 'lstart=', '-p', String(pid)]
        const [executable, ...args] = command
        if (!executable) marker = null
        else {
          const result = spawnSync(executable, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          const stdout = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : ''
          marker = stdout ? `${process.platform}-process-start:${stdout}` : null
        }
      }
    } catch {
      // Transient — retried below while the process is alive.
    }
    if (marker) return marker
    if (attempt < 2) {
      if (!isProcessAlive(pid)) return null
      sleepSync(20)
    }
  }
  return null
}

export function processIdentityMatches(pid: number, expected?: string): boolean {
  return !!expected && getProcessBirthIdentity(pid) === expected
}
