import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findServerEntry, resolveBunExecutable } from './server-spawner'

const roots: string[] = []
const originalServerEntry = process.env.POLO_AI_SERVER_ENTRY
const originalBun = process.env.POLO_AI_BUN

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalServerEntry === undefined) delete process.env.POLO_AI_SERVER_ENTRY
  else process.env.POLO_AI_SERVER_ENTRY = originalServerEntry
  if (originalBun === undefined) delete process.env.POLO_AI_BUN
  else process.env.POLO_AI_BUN = originalBun
})

describe('packaged server resolution', () => {
  it('resolves the sibling packaged server artifact', () => {
    delete process.env.POLO_AI_SERVER_ENTRY
    const root = join(tmpdir(), `polo-server-resolve-${crypto.randomUUID()}`)
    roots.push(root)
    const cliDir = join(root, 'dist', 'cli')
    const server = join(root, 'dist', 'server', 'polo-server.js')
    mkdirSync(join(root, 'dist', 'server'), { recursive: true })
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(server, '')

    expect(findServerEntry(cliDir)).toBe(server)
  })

  it('uses and validates an explicit packaged server entry', () => {
    const root = join(tmpdir(), `polo-server-env-${crypto.randomUUID()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const server = join(root, 'server.js')
    writeFileSync(server, '')
    process.env.POLO_AI_SERVER_ENTRY = server
    expect(findServerEntry(root)).toBe(server)

    process.env.POLO_AI_SERVER_ENTRY = join(root, 'missing.js')
    expect(() => findServerEntry(root)).toThrow('not found')
  })

  it('prefers the bundled Bun path from the launcher', () => {
    process.env.POLO_AI_BUN = '/opt/Polo AI/vendor/bun/bun'
    expect(resolveBunExecutable()).toBe('/opt/Polo AI/vendor/bun/bun')
  })
})
