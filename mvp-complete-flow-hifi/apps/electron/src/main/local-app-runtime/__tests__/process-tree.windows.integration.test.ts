import { describe, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWindowsJobObjectOwner } from '../process-tree'

const windowsIt = process.platform === 'win32' ? it : it.skip

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(25)
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}

describe('Windows Job Object integration', () => {
  windowsIt('reaps a daemon after its root and transient parent both exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-job-object-'))
    const pidFile = join(root, 'daemon.pid')
    let daemonPid = 0
    const owner = await createWindowsJobObjectOwner()
    const rootSource = String.raw`
      const { spawn } = require('child_process')
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => {
        input += chunk
        if (!input.includes('\n')) return
        const pidFile = input.trim()
        const middleSource = ${JSON.stringify(String.raw`
          const { spawn } = require('child_process')
          const { writeFileSync } = require('fs')
          const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: 'ignore',
          })
          writeFileSync(process.argv[1], String(daemon.pid))
          daemon.unref()
        `)}
        const middle = spawn(process.execPath, ['-e', middleSource, pidFile], {
          detached: true,
          stdio: 'ignore',
        })
        middle.unref()
        setTimeout(() => process.exit(0), 50)
      })
      process.stdin.resume()
    `
    const child = spawn(process.execPath, ['-e', rootSource], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    })

    try {
      expect(child.pid).toBeGreaterThan(0)
      owner.assignProcess(child.pid!)
      child.stdin!.end(`${pidFile}\n`)
      await waitFor(async () => {
        try {
          daemonPid = Number(await readFile(pidFile, 'utf8'))
          return Number.isSafeInteger(daemonPid) && daemonPid > 0
        } catch {
          return false
        }
      })
      if (child.exitCode == null && child.signalCode == null) {
        await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
      }
      await Bun.sleep(100)
      expect(isAlive(daemonPid)).toBe(true)

      await owner.terminate()
      await waitFor(() => !isAlive(daemonPid))
    } finally {
      await owner.terminate().catch(() => {})
      if (daemonPid && isAlive(daemonPid)) {
        const killer = spawn('taskkill', ['/pid', String(daemonPid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        await new Promise<void>(resolveExit => killer.once('exit', () => resolveExit()))
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
