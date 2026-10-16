// Runs in a private fixture process so config/credential singletons cannot leak between tests.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2]!)
process.env.HOME = root; process.env.POLO_AI_CONFIG_DIR = root; process.env.POLO_AI_RUNTIME_DISCOVERY_FILE = join(root, 'runtime/electron.json')
const desktop = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/managed-desktop.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
const errors = new Response(desktop.stderr).text()
const reader = desktop.stdout.getReader(); let ready = ''
try {
  while (!ready.includes('\n')) { const row = await reader.read(); if (row.done) throw new Error(await errors); ready += new TextDecoder().decode(row.value) }
  const fixture = JSON.parse(ready.split('\n')[0]!)
  const { createCliThread, updateCliThread, acquireCliThreadLease } = await import('../cli-thread-store')
  const { connectManagedDesktop } = await import('../managed-broker-client')
  const connection = await connectManagedDesktop()
  const results: any[] = []
  try {
    for (const [name, patch, history] of [
      ['slug', { connection: { slug: 'polo-space-legacy' } }],
      ['originalSlug', { connection: { slug: 'synthetic', provenance: { kind: 'owned', originalSlug: 'polo-space-legacy' } } }],
      ['managedBy', { connection: { managedBy: 'admin' } }],
      ['provenanceManagedBy', { connection: { provenance: { kind: 'owned', managedBy: 'admin' } } }],
      ['kind', { connection: { provenance: { kind: 'managed' } } }],
      ['owned', { connection: { slug: 'owned', provenance: { kind: 'owned' } } }],
      ['session', { mainSessionId: 'saved-session' }],
      ['history', {}, true],
      ['new', {}],
    ] as const) {
      const record = await createCliThread({ origin: 'cli-exec', configurationScopeId: 'global', configurationWorkspacePath: root, workingDirectory: root, persistence: 'persistent' })
      await mkdir(join(record.directory, 'config-snapshot'))
      await updateCliThread(record, patch as any)
      if (history) { await mkdir(join(record.directory, 'sessions/old'), { recursive: true }); await writeFile(join(record.directory, 'sessions/old/session.jsonl'), '{}\n') }
      const owner = await acquireCliThreadLease(record)
      try {
        let descriptor: any, error = ''
        try { descriptor = await connection.client.invoke('cliManaged.begin', { threadId: record.metadata.threadId, configurationScopeId: 'global', ownerPid: process.pid, ownerBirth: owner.owner.cliProcessIdentity, ownerLease: owner.owner.leaseId }) } catch (e) { error = String(e) }
        if (descriptor) await connection.client.invoke('cliManaged.finish', { leaseId: descriptor.leaseId })
        const state = await (await fetch(fixture.admin + '/fixture/state')).json() as any
        results.push({ name, granted: !!descriptor, error, executions: state.executions.length, providerCalls: state.providerCalls, admissions: state.billing.length })
      } finally { await owner.release() }
    }
  } finally { connection.client.destroy() }
  console.log(JSON.stringify(results))
} finally { desktop.kill('SIGTERM'); await desktop.exited; await errors }
