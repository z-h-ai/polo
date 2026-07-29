import { spawn } from 'child_process'

const WINDOWS_PROCESS_QUERY_LIMIT_BYTES = 4 * 1024 * 1024
const WINDOWS_COMMAND_TIMEOUT_MS = 5_000
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000
const TERMINATION_PASSES = 4

export interface WindowsProcessRecord {
  pid: number
  parentPid: number
}

export interface WindowsProcessTreeAdapter {
  snapshot(): Promise<WindowsProcessRecord[]>
  killTree(pid: number): Promise<void>
}

export interface WindowsProcessTreeOwnerOptions {
  rootPid: number
  adapter: WindowsProcessTreeAdapter
  sampleIntervalMs?: number
}

/**
 * Tracks descendants while the root is alive and retains historical parent
 * PIDs, so a final snapshot can still find children after the root exits.
 */
export class WindowsProcessTreeOwner {
  private readonly rootPid: number
  private readonly adapter: WindowsProcessTreeAdapter
  private readonly ownedPids = new Set<number>()
  private readonly sampleIntervalMs: number
  private sampleTimer?: ReturnType<typeof setInterval>
  private samplePromise?: Promise<WindowsProcessRecord[]>
  private terminationPromise?: Promise<void>

  constructor(options: WindowsProcessTreeOwnerOptions) {
    this.rootPid = options.rootPid
    this.adapter = options.adapter
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
    this.ownedPids.add(this.rootPid)
    if (this.sampleIntervalMs > 0) {
      this.sampleTimer = setInterval(() => {
        void this.refreshOwnership().catch(() => {})
      }, this.sampleIntervalMs)
      this.sampleTimer.unref?.()
      void this.refreshOwnership().catch(() => {})
    }
  }

  terminate(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise
    this.terminationPromise = this.performTermination()
    return this.terminationPromise
  }

  private async performTermination(): Promise<void> {
    this.stopSampling()

    for (let pass = 0; pass < TERMINATION_PASSES; pass += 1) {
      let snapshot: WindowsProcessRecord[]
      try {
        snapshot = await this.refreshOwnership()
      } catch (error) {
        await Promise.allSettled(
          [...this.ownedPids]
            .filter(pid => pid !== process.pid)
            .map(pid => this.adapter.killTree(pid)),
        )
        if (pass === TERMINATION_PASSES - 1) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      const liveOwned = snapshot
        .filter(processRecord => this.ownedPids.has(processRecord.pid))
        .map(processRecord => processRecord.pid)
        .filter(pid => pid !== process.pid)
      if (liveOwned.length === 0) return
      await Promise.allSettled(liveOwned.map(pid => this.adapter.killTree(pid)))
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const finalSnapshot = await this.refreshOwnership()
    const survivors = finalSnapshot
      .filter(processRecord => this.ownedPids.has(processRecord.pid))
      .map(processRecord => processRecord.pid)
      .filter(pid => pid !== process.pid)
    if (survivors.length > 0) {
      throw new Error(`Windows process tree still has live descendants: ${survivors.join(', ')}`)
    }
  }

  private refreshOwnership(): Promise<WindowsProcessRecord[]> {
    if (this.samplePromise) return this.samplePromise
    const sample = this.adapter.snapshot()
      .then((snapshot) => {
        let changed = true
        while (changed) {
          changed = false
          for (const processRecord of snapshot) {
            if (
              !this.ownedPids.has(processRecord.pid)
              && this.ownedPids.has(processRecord.parentPid)
            ) {
              this.ownedPids.add(processRecord.pid)
              changed = true
            }
          }
        }
        return snapshot
      })
      .finally(() => {
        if (this.samplePromise === sample) this.samplePromise = undefined
      })
    this.samplePromise = sample
    return sample
  }

  private stopSampling(): void {
    if (!this.sampleTimer) return
    clearInterval(this.sampleTimer)
    this.sampleTimer = undefined
  }
}

export function createWindowsProcessTreeOwner(rootPid: number): WindowsProcessTreeOwner {
  return new WindowsProcessTreeOwner({
    rootPid,
    adapter: {
      snapshot: queryWindowsProcesses,
      killTree: killWindowsProcessTree,
    },
  })
}

async function queryWindowsProcesses(): Promise<WindowsProcessRecord[]> {
  const command = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId',
    '| ConvertTo-Json -Compress',
  ].join(' ')
  const output = await runWindowsCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], true)
  const normalizedOutput = output.trim().replace(/^\uFEFF/, '')
  if (!normalizedOutput) return []
  const parsed = JSON.parse(normalizedOutput) as
    | { ProcessId?: unknown; ParentProcessId?: unknown }
    | Array<{ ProcessId?: unknown; ParentProcessId?: unknown }>
  const records = Array.isArray(parsed) ? parsed : [parsed]
  return records.flatMap((record) => {
    const pid = Number(record.ProcessId)
    const parentPid = Number(record.ParentProcessId)
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid)
      ? [{ pid, parentPid }]
      : []
  })
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await runWindowsCommand('taskkill', ['/pid', String(pid), '/T', '/F'], false)
}

function runWindowsCommand(
  command: string,
  args: string[],
  requireSuccess: boolean,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error, output = '') => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectCommand(error)
      else resolveCommand(output)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} exceeded ${WINDOWS_COMMAND_TIMEOUT_MS}ms`))
    }, WINDOWS_COMMAND_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= WINDOWS_PROCESS_QUERY_LIMIT_BYTES) chunks.push(chunk)
    })
    child.once('error', error => finish(error))
    child.once('exit', (code) => {
      if (bytes > WINDOWS_PROCESS_QUERY_LIMIT_BYTES) {
        finish(new Error('Windows process snapshot exceeded its output limit'))
      } else if (requireSuccess && code !== 0) {
        finish(new Error(`${command} exited with code ${code ?? 'null'}`))
      } else {
        finish(undefined, Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}
