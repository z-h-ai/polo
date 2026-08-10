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
    const incoming = join(root, 'electron', '.incoming', '1.0.0')
    const staging = join(root, 'electron', 'releases', '.1.0.0.staging-123')
    const published = join(root, 'electron', 'releases', '1.0.0')
    const temporaryLatest = join(root, 'electron', '.latest-123')
    const releaseJob = join(root, 'electron', '.jobs', '1.0.0')
    const caddyfile = join(process.cwd(), 'infra/updates-static/PoloCaddyfile')
    let containerId = ''
    try {
      await Promise.all([
        mkdir(latest, { recursive: true }),
        mkdir(incoming, { recursive: true }),
        mkdir(staging, { recursive: true }),
        mkdir(published, { recursive: true }),
        mkdir(temporaryLatest, { recursive: true }),
        mkdir(releaseJob, { recursive: true }),
        mkdir(join(root, 'electron', '.publisher.lock'), { recursive: true }),
        mkdir(join(temporaryLatest, 'nested'), { recursive: true }),
        mkdir(join(latest, '.publisher-state'), { recursive: true }),
        mkdir(join(published, '.publisher-state'), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(latest, 'install-app.sh'), '#!/bin/sh\n'),
        writeFile(join(latest, 'latest-mac.yml'), 'version: 1.0.0\n'),
        writeFile(join(latest, 'release-contract.json'), '{}\n'),
        writeFile(join(latest, 'Polo-AI-x64.exe'), 'windows installer'),
        writeFile(join(incoming, 'release-contract.json'), 'private incoming'),
        writeFile(join(staging, 'Polo-AI-x64.exe'), 'private staging'),
        writeFile(join(published, 'Polo-AI-x64.exe'), 'version directory is not public before confirmation'),
        writeFile(join(root, 'electron', '.publisher.lock', 'owner.json'), 'private lock owner'),
        writeFile(join(temporaryLatest, 'release-contract.json'), 'private temporary latest'),
        writeFile(join(temporaryLatest, 'nested', 'state.json'), 'private temporary latest child'),
        writeFile(join(latest, '.publisher-state', 'state.json'), 'private latest child'),
        writeFile(join(published, '.publisher-state', 'state.json'), 'private release child'),
        writeFile(join(root, 'electron', '.rollback-1.0.0.json'), 'private rollback'),
        writeFile(join(root, 'electron', '.confirmed-1.0.0.json'), 'private confirmation'),
        writeFile(join(releaseJob, 'state.json'), 'private job state'),
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
      const serviceRoot = `http://127.0.0.1:${port}`
      for (const path of [
        '/electron/.incoming/1.0.0/release-contract.json',
        '/electron/releases/.1.0.0.staging-123/Polo-AI-x64.exe',
        '/electron/.publisher.lock',
        '/electron/.publisher.lock/owner.json',
        '/electron/.latest-123/release-contract.json',
        '/electron/.latest-123/nested/state.json',
        '/electron/latest/.publisher-state/state.json',
        '/electron/.rollback-1.0.0.json',
        '/electron/.jobs/1.0.0/state.json',
        '/electron/.confirmed-1.0.0.json',
        '/electron/releases/1.0.0/Polo-AI-x64.exe',
        '/electron/releases/1.0.0/.publisher-state/state.json',
      ]) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(`${serviceRoot}${path}`, { method })
          if (response.ok) throw new Error(`${method} ${path} was publicly served`)
        }
      }
      expect((await fetch(`${baseUrl}/install-app.sh`, { method: 'POST' })).status).toBe(405)
    } finally {
      if (containerId) await docker(['rm', '-f', containerId])
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
