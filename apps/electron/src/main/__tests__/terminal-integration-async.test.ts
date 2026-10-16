import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTerminalIntegrationStatus, installTerminalIntegration, uninstallTerminalIntegration, type TerminalIntegrationOptions } from '../terminal-integration'

const roots: string[] = []
function fixture(script: string): TerminalIntegrationOptions {
  const root = mkdtempSync(join(tmpdir(), 'polo-terminal-async-'))
  roots.push(root)
  const shell = join(root, 'slow-shell')
  writeFileSync(shell, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  const resourcesPath = join(root, 'App.app', 'Contents', 'Resources')
  const bin = join(resourcesPath, 'app', 'resources', 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  writeFileSync(join(bin, 'polo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { platform: 'darwin', homeDir: join(root, 'home'), shell, resourcesPath,
    appExecutable: join(root, 'App.app', 'Contents', 'MacOS', 'App'), appVersion: '0.16.3', shellTimeoutMs: 1000 }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('asynchronous terminal integration', () => {
  it('keeps the event loop responsive while a real login shell is slow', async () => {
    const options = fixture('/bin/sleep 0.25\nprintf "__POLO_COMMAND__\\n"')
    const heartbeat = new Promise<string>(resolve => setTimeout(() => resolve('heartbeat'), 20))
    const status = Promise.resolve(getTerminalIntegrationStatus(options))
    expect(await Promise.race([heartbeat, status.then(() => 'status')])).toBe('heartbeat')
    expect((await status).shellCheck?.status).toBe('ok')
  })

  it('shares concurrent identical status probes but probes again after completion', async () => {
    const options = fixture('/bin/sleep 0.1\nprintf "__POLO_COMMAND__\\n"')
    const first = getTerminalIntegrationStatus(options)
    const second = getTerminalIntegrationStatus({ ...options })
    expect(first).toBe(second)
    await first
    const next = getTerminalIntegrationStatus(options)
    expect(next).not.toBe(first)
    await next
  })

  it('times out and kills slow shell descendants without blocking timers', async () => {
    const options = fixture('/bin/sleep 30 &\nprintf "%s" "$!" > "$HOME/child.pid"\nwait')
    options.shellTimeoutMs = 150
    let beats = 0
    const timer = setInterval(() => beats++, 10)
    let result
    try { result = await getTerminalIntegrationStatus(options) } finally { clearInterval(timer) }
    expect(result.shellCheck?.status).toBe('timeout')
    expect(result.pathReady).toBe(false)
    expect(beats).toBeGreaterThan(2)
    const pidFile = join(options.homeDir!, 'child.pid')
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('fails closed and stops an unbounded shell output stream', async () => {
    const options = fixture('while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done')
    options.shellOutputLimit = 256
    const status = await getTerminalIntegrationStatus(options)
    expect(status.shellCheck).toMatchObject({ status: 'failed', outputTruncated: true })
    expect(status.pathReady).toBe(false)
  })

  it('serializes install, status and uninstall against a pending probe', async () => {
    const options = fixture('/bin/sleep 0.05\nprintf "__POLO_COMMAND__\\n"')
    const pending = getTerminalIntegrationStatus(options)
    const install = installTerminalIntegration(options)
    const uninstall = uninstallTerminalIntegration(options)
    const after = getTerminalIntegrationStatus(options)
    expect(after).not.toBe(pending)
    expect((await pending).installed).toBe(false)
    expect((await install).installed).toBe(true)
    expect((await uninstall).installed).toBe(false)
    expect((await after).installed).toBe(false)
    expect(existsSync(join(options.homeDir!, '.local', 'bin', 'polo'))).toBe(false)
  })
})
