import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Broker direct begin rejects every managed marker without owner and never upgrades saved owned/history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-history-policy-'))
  try {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/managed-history-probes.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, err).toBe(0)
    const results = JSON.parse(out.trim()) as any[]
    expect(results).toHaveLength(9)
    for (const result of results) {
      expect(result.granted, result.name).toBe(result.name === 'new')
      if (['slug', 'originalSlug', 'managedBy', 'provenanceManagedBy', 'kind'].includes(result.name)) expect(result.error).toContain('POLO_THREAD_OWNER_UNKNOWN')
      if (['owned', 'session', 'history'].includes(result.name)) expect(result.error).toContain('POLO_THREAD_COMPUTE_SOURCE_MISMATCH')
      expect(result.executions).toBe(0); expect(result.providerCalls).toBe(0); expect(result.admissions).toBe(0)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
