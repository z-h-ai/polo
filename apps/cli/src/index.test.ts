import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { printHelp } from './index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

describe('top-level CLI help', () => {
  it('uses polo as the primary command and mentions polo-ai only as an alias', () => {
    let output = ''
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      printHelp()
    } finally {
      process.stdout.write = originalWrite
    }

    expect(output).toStartWith('polo — Terminal client for Polo AI')
    expect(output).toContain('Usage: polo [options]')
    expect(output).toContain('Compatibility: polo-ai is retained as an alias for polo.')
    expect(output.match(/polo-ai/g)).toHaveLength(1)
    expect(output).not.toContain('polo-ai run')
  })

  it('never routes run with legacy server options to the old full server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-run-routing-'))
    tempDirs.push(root)
    for (const args of [
      ['--url', 'ws://electron.invalid', 'run', 'hello'],
      ['--token', 'server-secret', 'run', 'hello'],
      ['--tls-ca', join(root, 'ca.pem'), 'run', 'hello'],
      ['run', '--url', 'ws://electron.invalid', 'hello'],
      ['run', '--token', 'server-secret', 'hello'],
      ['run', '--tls-ca', join(root, 'ca.pem'), 'hello'],
    ]) {
      const proc = Bun.spawn([
        'bun',
        'run',
        join(import.meta.dir, 'index.ts'),
        ...args,
      ], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, POLO_AI_CONFIG_DIR: root },
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(stderr).toMatch(/unsupported option for run: --(?:url|token|tls-ca)/)
      expect(await Bun.file(join(root, 'sessions')).exists()).toBe(false)
    }
  }, 20_000)
})
