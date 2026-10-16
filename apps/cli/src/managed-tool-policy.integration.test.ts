import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('managed yolo cannot execute detached Bash, proxy scripts or prefetch, or evaluate cwd Pi packages/extensions', async () => {
  const retained = process.env.POLO_REVIEW_EVIDENCE
  const root = retained ? join(resolve(retained), 'policy-fixture-' + Date.now()) : await mkdtemp(join(tmpdir(), 'polo-managed-policy-'))
  await mkdir(root, { recursive: true })
  const desktop = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/managed-desktop.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
  const errors = new Response(desktop.stderr).text()
  const reader = desktop.stdout.getReader(); let ready = ''
  const timer = setTimeout(() => desktop.kill('SIGKILL'), 15000)
  const trace: unknown[] = []
  try {
    while (!ready.includes('\n')) { const row = await reader.read(); if (row.done) throw new Error(await errors); ready += new TextDecoder().decode(row.value) }
    clearTimeout(timer)
    const fixture = JSON.parse(ready.split('\n')[0]!)
    const state = async () => await (await fetch(fixture.admin + '/fixture/state')).json() as any
    const work = join(root, 'work')
    await mkdir(join(work, '.pi/extensions'), { recursive: true })
    await mkdir(join(work, 'probe-package'), { recursive: true })
    const probe = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(work, 'extension-evaluated.txt'))}, 'BAD'); export default function() {}`
    await writeFile(join(work, '.pi/extensions/review-probe.ts'), probe)
    await writeFile(join(work, 'probe-package/index.ts'), probe.replace('extension-evaluated', 'package-evaluated'))
    await writeFile(join(work, 'probe-package/package.json'), JSON.stringify({ name: 'local-review-probe', version: '1.0.0', pi: { extensions: ['./index.ts'] }, scripts: { postinstall: `touch ${join(work, 'install-ran.txt')}` } }))
    await writeFile(join(work, '.pi/settings.json'), JSON.stringify({ packages: ['../probe-package'], extensions: ['./extensions/review-probe.ts'] }))
    const run = async (prompt: string, yolo = true) => {
      const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'exec', '--provider', 'polo', '--json', ...(yolo ? ['--yolo'] : []), '-C', work, prompt], { env: { ...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, POLO_AI_RUNTIME_DISCOVERY_FILE: join(root, 'runtime/electron.json'), LLM_API_KEY: '', LLM_BASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' })
      const deadline = setTimeout(() => child.kill('SIGTERM'), 35000)
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(deadline))
      trace.push({ prompt, code, out, err })
      return { code, out, err }
    }
    const escaped = await run('POLICY_PROBE:bash')
    // Wait beyond the original exploit before checking, retaining both traces.
    await new Promise(r => setTimeout(r, 5500))
    const after = await state()
    trace.push({ backgroundPid: await readFile(join(work, 'background.pid'), 'utf8').catch(() => null), lateFile: existsSync(join(work, 'late.txt')), bodies: after.bodies, billing: after.billing, executions: after.executions })
    expect(existsSync(join(work, 'background.pid'))).toBe(false)
    expect(existsSync(join(work, 'late.txt'))).toBe(false)
    expect(existsSync(join(work, 'extension-evaluated.txt'))).toBe(false)
    expect(existsSync(join(work, 'package-evaluated.txt'))).toBe(false)
    expect(existsSync(join(work, 'install-ran.txt'))).toBe(false)
    expect(escaped.out + escaped.err).toContain('POLO_MANAGED_TOOL_UNSUPPORTED')
    expect(after.bodies[0].tools.map((t: any) => t.function.name).sort()).toEqual(['edit', 'ls', 'read', 'write'])
    expect(after.bodies[1].messages.some((m: any) => m.role === 'tool' && /not found|unsupported/i.test(JSON.stringify(m.content)))).toBe(true)
    for (const name of ['grep', 'find', 'mcp__session__script_sandbox', 'mcp__session__transform_data', 'prefetch']) {
      const before = (await state()).providerCalls
      const result = await run('POLICY_PROBE:' + name)
      expect(result.out + result.err).toContain('POLO_MANAGED_TOOL_UNSUPPORTED')
      expect((await state()).providerCalls - before).toBe(2) // no speculative call_llm provider calls
    }
    expect(existsSync(join(work, 'script.txt'))).toBe(false)
    expect((await state()).executions).toEqual([])
    expect(await (await fetch(fixture.admin + '/fixture/control', { method: 'POST', body: JSON.stringify({ switch: 'enterprise' }) })).json()).toEqual({ ok: true })
    const nonce = crypto.randomUUID()
    await writeFile(join(work, 'input.txt'), nonce)
    const safe = await run('FILE_LOOP read input.txt then write output.txt', false)
    expect(existsSync(join(work, 'output.txt'))).toBe(false)
    expect(safe.out).toContain('error')
    await run('FILE_LOOP read input.txt then write output.txt')
    expect(await readFile(join(work, 'output.txt'), 'utf8')).toBe(nonce)
  } finally {
    clearTimeout(timer); desktop.kill('SIGTERM'); await desktop.exited
    const err = await errors
    if (retained) { await writeFile(join(root, 'review-trace.json'), JSON.stringify(trace, null, 2)); await writeFile(join(root, 'desktop.stderr'), err) }
    else await rm(root, { recursive: true, force: true })
  }
}, 180000)
