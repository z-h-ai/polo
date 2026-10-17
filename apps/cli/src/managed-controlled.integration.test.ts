import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('controlled real CLI → desktop Broker/proxy → Admin/Provider: personal+enterprise tools, billing, owner isolation and revoke', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-cli-managed-'))
  const desktop = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/managed-desktop.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
  const errors = new Response(desktop.stderr).text()
  const reader = desktop.stdout.getReader()
  let stdout = ''
  const ready = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`fixture desktop failed: ${await errors}`)
      stdout += new TextDecoder().decode(value)
      if (stdout.includes('\n')) return JSON.parse(stdout.split('\n')[0]!)
    }
  })()
  const startupDeadline = setTimeout(() => desktop.kill('SIGKILL'), 15000)
  let current: ReturnType<typeof Bun.spawn> | undefined
  try {
    const fixture = await ready
    clearTimeout(startupDeadline)
    const state = async () => await (await fetch(fixture.admin + '/fixture/state')).json() as any
    const control = async (value: unknown) => await (await fetch(fixture.admin + '/fixture/control', { method: 'POST', body: JSON.stringify(value) })).json() as any
    const spawn = (args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], { env: { ...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, POLO_AI_RUNTIME_DISCOVERY_FILE: join(root, 'runtime/electron.json'), LLM_API_KEY: '', LLM_BASE_URL: '', POLO_AI_BUNDLED_ASSETS_ROOT: resolve('apps/electron') }, stdout: 'pipe', stderr: 'pipe' })
      current = child
      const timer = setTimeout(() => child.kill('SIGTERM'), 40000)
      return { child, result: Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer)) }
    }
    const run = async (args: string[], success = true) => {
      const [code, out, err] = await spawn(args).result
      if (success && code !== 0) throw new Error(`CLI ${code}: ${err}\n${out}`)
      if (!success) expect(code).not.toBe(0)
      return { code, out, err }
    }
    // Invalid Admin transport/auth combinations must fail before any Provider call.
    for (const connectionOverrides of [
      { providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key' },
      { authType: 'api_key' }, { authType: 'oauth' }, { authType: 'none' },
      { customEndpoint: { api: 'anthropic-messages' } },
      { customEndpoint: { api: 'openai-responses' } }, { customEndpoint: null },
      { baseUrl: 'ftp://127.0.0.1/v1' }, { baseUrl: 'https://user:pass@example.invalid/v1' },
    ]) {
      await control({ connectionOverrides })
      const rejected = await run(['exec', '--provider', 'polo', '--json', '-C', join(root, 'work'), 'Reject invalid transport.'], false)
      expect(rejected.out + rejected.err).toContain('POLO_MANAGED_PROTOCOL_UNSUPPORTED')
      expect((await state()).providerCalls).toBe(0)
      expect((await state()).billing).toEqual([])
    }
    await control({ connectionOverrides: {} })
    const probes = await control({ probes: true })
    expect(probes.rejected).toHaveLength(14)
    expect(probes.duplicateFinish).toBe(true)
    expect(probes.stopFailureRetained).toBe(true)
    expect(probes.providerCalls).toBe(0)
    const work = join(root, 'work'), nonce = crypto.randomUUID()
    await writeFile(join(work, 'input.txt'), nonce)
    const first = await run(['exec', '--provider', 'polo', '--json', '--yolo', '-C', work, 'FILE_LOOP Read input.txt and write output.txt.'])
    expect(await readFile(join(work, 'output.txt'), 'utf8')).toBe(nonce)
    const thread = first.out.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.type === 'thread.started')?.thread_id
    expect(thread).toBeTruthy()
    let facts = await state()
    expect(facts.providerCalls).toBeGreaterThanOrEqual(3)
    expect(facts.bodies[1].messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes(nonce))).toBe(true)
    for (const kind of ['start', 'admit', 'usage', 'finish']) expect(facts.billing.filter((b: any) => b.kind === kind).length).toBe(facts.providerCalls)
    expect(facts.billing.filter((b: any) => b.kind === 'start').every((b: any) => b.input.subjectKind === 'polo_assistant' && b.input.productSpaceId === fixture.personal)).toBe(true)
    expect(new Set(facts.billing.filter((b: any) => b.kind === 'admit').map((b: any) => b.input.requestId)).size).toBe(facts.providerCalls)
    expect(facts.secretsOnDisk).toEqual([])
    const crossProvider = await run(['exec', 'resume', thread, '--provider', 'anthropic', '--api-key', 'forbidden-owned-key', '--json', 'Never forward this history.'], false)
    expect(crossProvider.out + crossProvider.err).toContain('POLO_THREAD_COMPUTE_SOURCE_MISMATCH')
    expect((await state()).providerCalls).toBe(facts.providerCalls)
    await run(['exec', 'resume', thread, '--provider', 'polo', '--json', 'Resume and reply.'])
    await control({ switch: 'enterprise' })
    const before = (await state()).providerCalls
    const deniedResume = await run(['exec', 'resume', thread, '--provider', 'polo', '--json', 'Private history must not be sent.'], false)
    expect(deniedResume.out + deniedResume.err).toContain('POLO_THREAD_OWNER_MISMATCH')
    const listing = await run(['exec', 'sessions', '--json', '-C', work])
    expect(listing.out).not.toContain(thread)
    expect((await state()).providerCalls).toBe(before)
    await run(['exec', '--provider', 'polo', '--model', 'wrong-model', '-C', work, 'Reject wrong model.'], false)
    await run(['exec', '--provider', 'polo', '--api-key', 'not-allowed', '-C', work, 'Reject key.'], false)
    expect((await state()).providerCalls).toBe(before)
    await run(['exec', '--provider', 'polo', '-C', work, 'Enterprise minimal reply.'])
    facts = await state()
    expect(facts.billing.filter((b: any) => b.kind === 'start').at(-1).input.productSpaceId).toBe(fixture.enterprise)
    await control({ denied: true })
    const beforeDenied = facts.providerCalls
    await run(['exec', '--provider', 'polo', '-C', work, 'Reject insufficient credit.'], false)
    expect((await state()).providerCalls).toBe(beforeDenied)
    await control({ denied: false, receiptFailure: true })
    const receiptBefore = (await state()).providerCalls
    await run(['exec', '--provider', 'polo', '-C', work, 'Receipt outage minimal reply.'])
    const receiptState = await state()
    expect(receiptState.providerCalls).toBe(receiptBefore + 1)
    expect(receiptState.outbox.some((entry: any) => entry.phase === 'receipt' && entry.scope.productSpaceId === fixture.enterprise && entry.scope.accountId === receiptState.accountId)).toBe(true)
    await control({ receiptFailure: false, hold: true })
    const beforeActive = (await state()).providerCalls
    const active = spawn(['exec', '--provider', 'polo', '-C', work, 'Wait for revocation.'])
    for (let i = 0; i < 80 && (await state()).providerCalls === beforeActive; i++) await new Promise(r => setTimeout(r, 50))
    expect((await state()).providerCalls).toBe(beforeActive + 1)
    const switched = await control({ switch: 'personal' })
    expect(switched).toEqual({ ok: true })
    expect((await active.result)[0]).not.toBe(0)
    const stoppedCalls = (await state()).providerCalls
    await new Promise(r => setTimeout(r, 200))
    expect((await state()).providerCalls).toBe(stoppedCalls)
    expect((await state()).secretsOnDisk).toEqual([])
    expect(await control({ quit: true })).toEqual({ stopped: true })
  } finally {
    clearTimeout(startupDeadline)
    current?.kill('SIGTERM')
    desktop.kill('SIGTERM')
    await desktop.exited
    const fixtureErrors = await errors
    if (fixtureErrors.trim()) console.error(fixtureErrors)
    await rm(root, { recursive: true, force: true })
  }
}, 150000)
