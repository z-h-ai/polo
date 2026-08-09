import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

async function docker(args: string[]): Promise<string> {
  const process = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${stderr}`)
  return stdout.trim()
}

describe('updates-static Caddy cache contract', () => {
  it('serves the installer, manifests, and contract as no-cache while binaries are immutable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-updates-caddy-'))
    const latest = join(root, 'electron', 'latest')
    const caddyfile = join(process.cwd(), 'infra/updates-static/PoloCaddyfile')
    let containerId = ''
    try {
      await mkdir(latest, { recursive: true })
      await Promise.all([
        writeFile(join(latest, 'install-app.sh'), '#!/bin/sh\n'),
        writeFile(join(latest, 'latest-mac.yml'), 'version: 1.0.0\n'),
        writeFile(join(latest, 'release-contract.json'), '{}\n'),
        writeFile(join(latest, 'Polo-AI-x64.exe'), 'windows installer'),
      ])
      containerId = await docker([
        'run', '-d', '--rm', '-p', '127.0.0.1::8080',
        '-v', `${root}:/data/releases:ro`,
        '-v', `${caddyfile}:/etc/caddy/Caddyfile:ro`,
        'caddy:2.10-alpine',
      ])
      const port = (await docker(['port', containerId, '8080/tcp'])).split(':').at(-1)
      if (!port) throw new Error('Docker did not expose Caddy port 8080')
      const baseUrl = `http://127.0.0.1:${port}/electron/latest`
      let response: Response | undefined
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          response = await fetch(`${baseUrl}/release-contract.json`, { method: 'HEAD' })
          if (response.ok) break
        } catch {
          // Caddy may still be starting.
        }
        await Bun.sleep(50)
      }
      expect(response?.ok).toBe(true)
      for (const name of ['install-app.sh', 'latest-mac.yml', 'release-contract.json']) {
        const head = await fetch(`${baseUrl}/${name}`, { method: 'HEAD' })
        expect(head.headers.get('cache-control')).toContain('no-cache')
      }
      const binary = await fetch(`${baseUrl}/Polo-AI-x64.exe`, { method: 'HEAD' })
      expect(binary.headers.get('cache-control')).toContain('public, max-age=31536000, immutable')
      expect((await fetch(`${baseUrl}/install-app.sh`, { method: 'POST' })).status).toBe(405)
    } finally {
      if (containerId) await docker(['rm', '-f', containerId])
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
