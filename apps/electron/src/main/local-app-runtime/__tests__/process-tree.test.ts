import { describe, expect, it } from 'bun:test'
import {
  WindowsProcessTreeOwner,
  type WindowsProcessRecord,
  type WindowsProcessTreeAdapter,
} from '../process-tree'

describe('WindowsProcessTreeOwner', () => {
  it('discovers and kills descendants even after the managed root has exited', async () => {
    const killed = new Set<number>()
    const processes: WindowsProcessRecord[] = [
      // Root PID 100 is intentionally absent: it already crashed.
      { pid: 101, parentPid: 100 },
      { pid: 102, parentPid: 101 },
      { pid: 900, parentPid: 1 },
    ]
    const adapter: WindowsProcessTreeAdapter = {
      snapshot: async () => processes.filter(record => !killed.has(record.pid)),
      killTree: async (pid) => {
        killed.add(pid)
      },
    }
    const owner = new WindowsProcessTreeOwner({
      rootPid: 100,
      adapter,
      sampleIntervalMs: 0,
    })

    await owner.terminate()

    expect([...killed].sort()).toEqual([101, 102])
    expect(killed.has(900)).toBe(false)
  })

  it('shares one termination operation across concurrent cleanup callers', async () => {
    let snapshots = 0
    const adapter: WindowsProcessTreeAdapter = {
      snapshot: async () => {
        snapshots += 1
        return []
      },
      killTree: async () => {},
    }
    const owner = new WindowsProcessTreeOwner({
      rootPid: 200,
      adapter,
      sampleIntervalMs: 0,
    })

    await Promise.all([owner.terminate(), owner.terminate()])
    expect(snapshots).toBe(1)
  })
})
