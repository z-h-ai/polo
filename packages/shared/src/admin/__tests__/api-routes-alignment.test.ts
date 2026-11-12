import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Vendors the polo-admin route manifest (scripts/export-api-routes.mjs →
// docs/api-routes.json) so this test can prove every admin API URL the client
// calls still exists server-side. When polo-admin adds/removes/renames a
// route, re-copy docs/api-routes.json over api-routes.vendored.json in the
// same change that consumes it; CI there gates the manifest against the
// source tree, so a stale vendor here shows up as a real drift, not noise.
const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'api-routes.vendored.json'), 'utf8')) as {
  schemaVersion: number
  routes: { path: string; methods: string[] }[]
}
const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.ts'), 'utf8')

// Every /api/… template or string literal in client.ts, one per source line
// (paths never span lines; multi-line call sites keep the path on one line).
const LITERAL_RE = /(?:`|'|")\/api\/[^`'"]*(?:`|'|")/g
const BASE_DECL_RE = /(?:const|let)\s+(base\w*)\s*=\s*(?:`|'|")\/api\/[^`'"]*(?:`|'|")/g

// `${a}` right after a "/" is a path parameter (wildcard segment); `${a}`
// glued to the previous segment (e.g. `/api/llm-connections${suffix}`) is a
// query-string concatenation and disappears entirely.
function normalizeLiteral(literal: string): string {
  const raw = literal.slice(1, -1)
  const withoutQuery = raw.slice(0, raw.indexOf('?') === -1 ? raw.length : raw.indexOf('?'))
  return withoutQuery
    .replace(/([^/])\$\{[^}]*\}/g, '$1')
    .replace(/\$\{[^}]*\}/g, '*')
}

// `const base = '/api/…'` declarations are intermediate values, not endpoints
// themselves (the release single-resource base only ever gets /upload-complete
// or /publish glued on); skip them as URLs but expand their references.
const baseTemplates = new Map<string, string>()
const baseDeclarationLiterals = new Set<string>()
for (const match of clientSource.matchAll(BASE_DECL_RE)) {
  const baseName = match[1]
  const literal = match[0].match(LITERAL_RE)?.[0]
  if (!baseName || !literal) continue
  baseTemplates.set(baseName, normalizeLiteral(literal))
  baseDeclarationLiterals.add(literal)
}

function normalizePath(literal: string): string {
  const expanded = literal.replace(/\$\{(base\w*)\}/g, (_, name: string) =>
    baseTemplates.get(name) ? `\`${baseTemplates.get(name)}\`` : '`${unknown-base-reference}`')
  return normalizeLiteral(expanded)
}

const referenced = new Set<string>()
for (const line of clientSource.split('\n')) {
  for (const match of line.match(LITERAL_RE) ?? []) {
    if (baseDeclarationLiterals.has(match)) continue
    // `return `/api/…${id}${suffix}`` shapes are base-URL builders handed to
    // the caller for further gluing (the PC client does exactly that); the
    // resource itself is not a routable endpoint, so skip it like `const base`.
    if (/return\s+`/.test(line) && match.slice(1, -1).endsWith('}')) continue
    referenced.add(normalizePath(match))
  }
}

function matchesManifest(clientPath: string): boolean {
  const clientSegments = clientPath.split('/').filter(Boolean)
  return manifest.routes.some((route) => {
    const manifestSegments = route.path.split('/').filter(Boolean)
    if (manifestSegments.length !== clientSegments.length) return false
    return manifestSegments.every((segment, index) =>
      segment === clientSegments[index] || segment.startsWith('[') || clientSegments[index] === '*')
  })
}

describe('admin client route alignment', () => {
  it('vendors a well-formed, sorted, non-empty polo-admin route manifest', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.routes.length).toBeGreaterThan(300)
    const paths = manifest.routes.map((route) => route.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths.every((path) => path.startsWith('/api/'))).toBe(true)
    expect(manifest.routes.every((route) => route.methods.length > 0)).toBe(true)
  })

  it('the manifest still contains the POO-205 client entry points', () => {
    for (const required of ['/api/llm-connections', '/api/me/organizations', '/api/browser-policy', '/api/kb/credential']) {
      expect(manifest.routes.some((route) => route.path === required)).toBe(true)
    }
  })

  it('every admin URL client.ts references exists in the vendored manifest', () => {
    const unmatched = [...referenced].filter((path) => !matchesManifest(path))
    expect(unmatched).toEqual([])
  })

  it('extracted client URLs are neither empty nor a single wildcard', () => {
    expect(referenced.size).toBeGreaterThan(50)
    expect([...referenced].every((path) => path.startsWith('/api/') && !/^\/api\/(\*\??)?$/.test(path))).toBe(true)
  })
})
