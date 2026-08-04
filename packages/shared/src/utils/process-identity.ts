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

/**
 * Return a stable, OS-observed birth marker for a currently running process.
 * A PID alone is deliberately not accepted as an identity because PIDs are
 * reused after process exit.
 */
export function getProcessBirthIdentity(pid: number): string | null {
  if (!isProcessAlive(pid)) return null
  try {
    if (process.platform === 'linux') {
      const statText = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const endOfCommand = statText.lastIndexOf(')')
      if (endOfCommand < 0) return null
      const fieldsAfterCommand = statText.slice(endOfCommand + 2).trim().split(/\s+/)
      const startTicks = fieldsAfterCommand[19]
      return startTicks ? `linux-proc-start:${startTicks}` : null
    }

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
    if (!executable) return null
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status !== 0) return null
    const marker = result.stdout.trim().replace(/\s+/g, ' ')
    return marker ? `${process.platform}-process-start:${marker}` : null
  } catch {
    return null
  }
}

export function processIdentityMatches(pid: number, expected?: string): boolean {
  return !!expected && getProcessBirthIdentity(pid) === expected
}
