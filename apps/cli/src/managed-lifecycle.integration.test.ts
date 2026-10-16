import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { processIdentityMatches } from '@polo-ai/shared/utils'

for (const trigger of ['cancel', 'owner-death', 'desktop-death', 'quit'] as const) test(`managed CLI cancels its actual server/worker on ${trigger}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-managed-lifecycle-'))
  const desktop = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/managed-desktop.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
  const desktopError = new Response(desktop.stderr).text()
  const reader = desktop.stdout.getReader()
  let buffer = ''
  const startupTimer = setTimeout(() => desktop.kill('SIGKILL'), 15000)
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    while (!buffer.includes('\n')) { const { done, value } = await reader.read(); if (done) throw new Error(await desktopError); buffer += new TextDecoder().decode(value) }
    clearTimeout(startupTimer)
    const fixture = JSON.parse(buffer.split('\n')[0]!)
    const state = async () => (await (await fetch(fixture.admin + '/fixture/state')).json()) as any
    const control = async (value: unknown) => (await (await fetch(fixture.admin + '/fixture/control', { method: 'POST', body: JSON.stringify(value) })).json()) as any
    await control({ hold: true })
    child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'exec', '--provider', 'polo', '--json', '-C', join(root, 'work'), 'Wait for lifecycle cancellation.'], { env: { ...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, POLO_AI_RUNTIME_DISCOVERY_FILE: join(root, 'runtime/electron.json'), LLM_API_KEY: '', LLM_BASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' })
    const output = new Response(child.stdout).text(), error = new Response(child.stderr).text()
    for (let i = 0; i < 120 && (await state()).providerCalls === 0; i++) await new Promise(r => setTimeout(r, 50))
    expect((await state()).providerCalls).toBe(1)
    const threads = await readdir(join(root, 'cli-sessions/global/executions'))
    const owner = JSON.parse(await readFile(join(root, 'cli-sessions/global/executions', threads[0]!, 'owner.json'), 'utf8'))
    expect(owner.cliPid).toBe(child.pid)
    if (trigger === 'cancel') child.kill('SIGTERM')
    if (trigger === 'owner-death') child.kill('SIGKILL')
    if (trigger === 'desktop-death') desktop.kill('SIGKILL')
    if (trigger === 'quit') expect(await control({ quit: true })).toEqual({ stopped: true })
    const deadline = setTimeout(() => child?.kill('SIGKILL'), 12000)
    const [code, stdout, stderr] = await Promise.all([child.exited, output, error])
    clearTimeout(deadline)
    expect(code).not.toBe(0)
    if (trigger !== 'owner-death') expect(stdout + stderr).not.toContain('turn.completed')
    for (let i = 0; i < 100 && processIdentityMatches(owner.serverPid, owner.serverProcessIdentity); i++) await new Promise(r => setTimeout(r, 50))
    expect(processIdentityMatches(owner.serverPid, owner.serverProcessIdentity)).toBe(false)
    if (trigger !== 'desktop-death') {
      for (let i = 0; i < 100 && (await state()).executions.length; i++) await new Promise(r => setTimeout(r, 50))
      expect((await state()).executions).toEqual([])
      expect((await state()).providerCalls).toBe(1)
      expect((await state()).secretsOnDisk).toEqual([])
    }
  } finally {
    clearTimeout(startupTimer)
    child?.kill('SIGTERM')
    desktop.kill('SIGTERM'); await desktop.exited
    const diagnostics = await desktopError
    if (diagnostics.trim()) console.error(diagnostics)
    await rm(root, { recursive: true, force: true })
  }
}, 45000)
