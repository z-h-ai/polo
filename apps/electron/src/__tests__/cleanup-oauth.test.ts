import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../..')

const productionExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json'])
const removedLower = ['oau', 'th'].join('')
const removedTitle = ['OAu', 'th'].join('')

function extensionOf(path: string): string {
  const match = /\.[^.]+$/.exec(path)
  return match?.[0] ?? ''
}

function collectProductionFiles(root: string): string[] {
  if (!existsSync(root)) return []

  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry)
    const stat = statSync(path)

    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') return []
      return collectProductionFiles(path)
    }

    return stat.isFile() && productionExtensions.has(extensionOf(path)) ? [path] : []
  })
}

function sourceMatches(root: string, pattern: RegExp): string[] {
  return collectProductionFiles(root)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(repoRoot, path))
    .sort()
}

describe('client-side auth flow cleanup contract', () => {
  it('removes deleted shared auth flow and server callback files', () => {
    const removedPaths = [
      'packages/shared/src/auth/claude-oauth.ts',
      'packages/shared/src/auth/claude-oauth-config.ts',
      'packages/shared/src/auth/chatgpt-oauth.ts',
      'packages/shared/src/auth/chatgpt-oauth-config.ts',
      'packages/shared/src/auth/google-oauth.ts',
      'packages/shared/src/auth/microsoft-oauth.ts',
      'packages/shared/src/auth/slack-oauth.ts',
      'packages/shared/src/auth/generic-oauth.ts',
      'packages/shared/src/auth/oauth.ts',
      'packages/shared/src/auth/oauth-relay.ts',
      'packages/shared/src/auth/oauth-flow-store.ts',
      'packages/shared/src/auth/oauth-flow-types.ts',
      'packages/shared/src/auth/callback-page.ts',
      'packages/shared/src/auth/callback-server.ts',
      'packages/shared/src/auth/pkce.ts',
      'packages/server-core/src/handlers/rpc/oauth.ts',
      'packages/server-core/src/webui/__tests__/oauth-callback.test.ts',
      'packages/server-core/src/handlers/oauth-flow-store-interface.ts',
    ]

    expect(removedPaths.filter((path) => existsSync(join(repoRoot, path)))).toEqual([])
  })

  it('removes shared auth index exports for deleted flow symbols', () => {
    const indexSource = readFileSync(join(repoRoot, 'packages/shared/src/auth/index.ts'), 'utf8')
    expect(indexSource).not.toMatch(new RegExp(`${removedLower}-flow|callback-page|callback-server|pkce|start${removedTitle}Flow|${removedTitle}Provider`))
  })

  it('deregisters the server RPC flow handler', () => {
    const rpcIndex = readFileSync(join(repoRoot, 'packages/server-core/src/handlers/rpc/index.ts'), 'utf8')
    expect(rpcIndex).not.toContain('registerOAuthHandlers')
    expect(rpcIndex).not.toContain(`./${removedLower}`)
  })

  it('removes WebUI callback route and callback page generation from server-core', () => {
    const matches = sourceMatches(
      join(repoRoot, 'packages/server-core/src'),
      /generateCallbackPage|\/api\/oauth\/callback/,
    )

    expect(matches).toEqual([])
  })
})
