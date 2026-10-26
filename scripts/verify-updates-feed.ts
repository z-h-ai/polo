// Post-release feed verifier: download the served updater manifest for a
// version and verify every listed artifact byte-for-byte (size + sha512).
// Catches manifest/artifact drift (duplicate-build hash skew) that
// version-pointer checks cannot see.
//
// Usage:
//   bun scripts/verify-updates-feed.ts --version 0.21.1 \
//     [--base https://updates.polo.z-h-ai.com/electron] \
//     [--resolve updates.polo.z-h-ai.com:443:111.230.240.195]
//
// Exit 0 = all artifacts verified; non-zero = any mismatch/missing artifact.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

interface FeedEntry { url: string; sha512: string; size: number }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const version = arg('version')
if (!version) {
  console.error('usage: verify-updates-feed.ts --version <v> [--base <url>] [--resolve host:port:ip]')
  process.exit(2)
}
const base = arg('base') ?? 'https://updates.polo.z-h-ai.com/electron'
const resolve = arg('resolve')

function fetchViaCurl(url: string, dest?: string): Buffer | string {
  const args = ['curl', '-sfL', ...(resolve ? ['--resolve', resolve] : []), url]
  if (dest) args.push('-o', dest)
  const r = spawnSync(args[0]!, args.slice(1), { maxBuffer: 1 << 28, encoding: 'buffer' })
  if (r.status !== 0) throw new Error(`curl failed (${r.status}) for ${url}`)
  return dest ? '' : (r.stdout as Buffer)
}

// The updater manifest is a flat, machine-generated YAML subset: top-level
// `version`, `path`, `sha512`, `releaseDate` plus a `files:` list whose items
// carry url/sha512/size. Parse only that shape — do not pull a YAML library.
function parseFeedEntries(yaml: string): { version: string; entries: FeedEntry[] } {
  const text = yaml.toString('utf8')
  const version = /^version:\s*(\S+)/m.exec(text)?.[1] ?? ''
  const entries: FeedEntry[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^files:\s*$/.test(lines[i]!)) {
      let cur: Partial<FeedEntry> = {}
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^ {2}- url:\s*(\S+)/.exec(lines[j]!)
        if (item) {
          if (cur.url && cur.sha512 && cur.size !== undefined) entries.push(cur as FeedEntry)
          cur = { url: item[1]! }
          continue
        }
        const sha = /^ {4}sha512:\s*(\S+)/.exec(lines[j]!)
        if (sha && cur.url) cur.sha512 = sha[1]!
        const size = /^ {4}size:\s*(\d+)/.exec(lines[j]!)
        if (size && cur.url) cur.size = Number(size[1])
      }
      if (cur.url && cur.sha512 && cur.size !== undefined) entries.push(cur as FeedEntry)
      break
    }
  }
  if (!version || entries.length === 0) throw new Error(`could not parse feed manifest (${version || 'no version'}, ${entries.length} entries)`)
  return { version, entries }
}

async function main(): Promise<void> {
  const feedUrl = `${base}/latest/latest-mac.yml`
  const manifest = fetchViaCurl(feedUrl)
  const { version: feedVersion, entries } = parseFeedEntries(manifest)
  if (feedVersion !== version) throw new Error(`feed points at ${feedVersion}, expected ${version}`)
  console.log(`feed version: ${feedVersion}, artifacts: ${entries.length}`)

  let failures = 0
  for (const entry of entries) {
    const artifactUrl = `${base}/releases/${version}/${entry.url}`
    const tmp = `/tmp/feed-verify-${version}-${entry.url}`
    console.log(`verifying ${entry.url} (${entry.size} bytes) …`)
    fetchViaCurl(artifactUrl, tmp)
    const data = await import('node:fs/promises').then(fs => fs.readFile(tmp))
    const sizeOk = data.length === entry.size
    const digest = createHash('sha512').update(data).digest('base64')
    const hashOk = digest === entry.sha512
    console.log(`  size: ${sizeOk ? 'ok' : `MISMATCH (${data.length})`}, sha512: ${hashOk ? 'ok' : 'MISMATCH'}`)
    if (!sizeOk || !hashOk) failures++
    await import('node:fs/promises').then(fs => fs.rm(tmp, { force: true }))
  }
  if (failures > 0) throw new Error(`${failures} artifact(s) failed verification for ${version}`)
  console.log(`ALL VERIFIED: ${version} feed is byte-for-byte consistent (${entries.length} artifacts)`)
}

main().catch(error => {
  console.error(`FEED VERIFY FAILED: ${(error as Error).message}`)
  process.exit(1)
})
