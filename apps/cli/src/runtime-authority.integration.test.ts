import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('real server rejects untrusted bootstraps, unauthorized RPCs, cross Thread and revoked owners before provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-authority-'))
  try {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/runtime-authority.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exitCode) throw new Error(stderr + stdout)
    const result = JSON.parse(stdout.trim())
    expect(result.modelCalls).toBe(0)
    expect(result.validRootCreated).toBe(true)
    expect(result.rejected.length).toBe(20)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
