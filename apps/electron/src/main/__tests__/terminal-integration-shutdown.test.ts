import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('stops active shell children and refuses queued installation on shutdown', async () => {
  if (process.platform !== 'darwin') return
  const root = mkdtempSync(join(tmpdir(), 'polo-terminal-shutdown-'))
  try {
    const home = join(root, 'home')
    mkdirSync(home)
    writeFileSync(join(home, '.zshrc'), '/bin/sleep 30 &\nprintf "%s" "$!" > "$HOME/child.pid"\nwait\n')
    const fixture = join(root, 'shutdown.ts')
    writeFileSync(fixture, `
      import { existsSync, readFileSync } from 'node:fs'
      import { getTerminalIntegrationStatus, installTerminalIntegration, shutdownTerminalIntegration } from ${JSON.stringify(join(import.meta.dir, '..', 'terminal-integration.ts'))}
      const options = ${JSON.stringify({ platform: 'darwin', homeDir: home, shell: '/bin/zsh', resourcesPath: join(root, 'Resources'), appExecutable: '/unused', appVersion: '0.16.3' })}
      const pending = getTerminalIntegrationStatus(options)
      const queued = installTerminalIntegration(options).then(() => 'unexpected success', error => error.errorCode)
      for (let i = 0; i < 300 && !existsSync(${JSON.stringify(join(home, 'child.pid'))}); i++) await Bun.sleep(10)
      const pid = Number(readFileSync(${JSON.stringify(join(home, 'child.pid'))}, 'utf8'))
      shutdownTerminalIntegration()
      if ((await pending).shellCheck?.status !== 'failed') throw Error('shutdown probe was marked ready')
      if (await queued !== 'install_failed') throw Error('queued install survived shutdown')
      await Bun.sleep(100)
      let alive = false
      try { process.kill(pid, 0); alive = true } catch {}
      if (alive) throw Error('shell child survived shutdown')
      if (existsSync(${JSON.stringify(join(home, '.zprofile'))})) throw Error('shutdown wrote shell profile')
      console.log('ok')
    `)
    const proc = Bun.spawn([process.execPath, fixture], { stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(stdout).toBe('ok\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
