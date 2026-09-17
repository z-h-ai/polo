/**
 * Process birth identity contract.
 *
 * The identity must be a STABLE, OS-observed marker for a live process:
 * cleanup liveness decisions (CLI Thread stale-ephemeral reclamation) trust
 * it, so a transient OS-query miss under parallel load must never flip a
 * live process to "missing".
 */
import { describe, expect, it } from 'bun:test'
import {
  getProcessBirthIdentity,
  processIdentityMatches,
} from './process-identity.ts'

describe('process birth identity', () => {
  it('returns a non-empty marker for a live process and keeps it STABLE across repeated queries', () => {
    const first = getProcessBirthIdentity(process.pid)
    expect(first).toBeTruthy()
    for (let i = 0; i < 20; i++) {
      expect(getProcessBirthIdentity(process.pid)).toBe(first)
    }
  })

  it('returns null for a dead pid and never matches it', () => {
    // PID 2^31-1 style high value: pick a pid that is not alive right now.
    let dead = 0
    for (let pid = 300; pid < 100000; pid++) {
      try {
        process.kill(pid, 0)
      } catch {
        dead = pid
        break
      }
    }
    expect(dead).toBeGreaterThan(0)
    expect(getProcessBirthIdentity(dead)).toBeNull()
    expect(processIdentityMatches(dead, getProcessBirthIdentity(process.pid) ?? undefined)).toBe(false)
  })

  it('matches a live process against its own identity only', () => {
    const identity = getProcessBirthIdentity(process.pid)
    expect(identity).toBeTruthy()
    expect(processIdentityMatches(process.pid, identity!)).toBe(true)
    expect(processIdentityMatches(process.pid, undefined)).toBe(false)
    expect(processIdentityMatches(process.pid, 'not-a-real-marker')).toBe(false)
  })
})
