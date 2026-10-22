import { describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { canonicalSkillRoot, installCanonicalSkill, readCanonicalSkillInstallations } from '../canonical.ts'
import { uninstallCreatorSkill } from '../installer.ts'
import type { CanonicalSkillSource } from '../types.ts'

const source: CanonicalSkillSource = { accountId: 'account-a', productSpaceId: 'space-a', subjectKind: 'personal_artifact', subjectId: 'work-k', versionId: 'version-k1' }
function bytes(text = 'Original K') { return zipSync({ 'same-slug/SKILL.md': strToU8(`---\nname: same-slug\ndescription: Tested canonical package.\n---\n${text}\n`) }) }
async function install(root: string, tuple = source, content = bytes(), options: Record<string, unknown> = {}) {
  let reads = 0
  const result = await installCanonicalSkill(root, { workspaceId: 'workspace-a', operationId: randomUUID(), source: tuple, version: '1.0.0', downloadUrl: 'https://canonical.example/download?launch=original', expiresAt: '2030-01-01T00:00:00.000Z', checksum: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength, ...options },
    { fetch: (async (_url, init) => { reads++; expect(init?.redirect).toBe('error'); return new Response(content) }) as typeof fetch })
  return { result, reads }
}
async function owned(run: (root: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), 'polo-canonical-skill-unit-')); try { await run(root) } finally { await rm(root, { recursive: true, force: true }) } }

describe('Canonical Skill uses real installer transactions and original tuple paths', () => {
  it('redeems a canonical one-use bundle with one bodyless POST and preserves the original signal and redirect guard', async () => owned(async root => {
    const content = bytes(), controller = new AbortController()
    const requests: RequestInit[] = []
    const result = await installCanonicalSkill(root, { workspaceId: 'workspace-a', operationId: randomUUID(), source, version: '1.0.0', downloadUrl: 'https://canonical.example/download?launch=original', expiresAt: '2030-01-01T00:00:00.000Z', checksum: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length }, {
      signal: controller.signal,
      fetch: (async (_url, init) => {
        requests.push(init ?? {})
        return new Response(init?.method === 'POST' && init.body === undefined && requests.length === 1 ? content : null, { status: init?.method === 'POST' && requests.length === 1 ? 200 : 400 })
      }) as typeof fetch,
    })
    expect(result.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', redirect: 'error', signal: controller.signal })
    expect(requests[0]!.body).toBeUndefined()
    expect((await readCanonicalSkillInstallations(root, source))[0]!.installation.canonicalSource).toEqual(source)
  }))
  it('downloads once, derives unchanged slug from verified ZIP, persists no fake organization', async () => owned(async root => {
    const { result, reads } = await install(root)
    expect(result.success).toBe(true); expect(reads).toBe(1)
    const rows = await readCanonicalSkillInstallations(root, source)
    expect(rows).toHaveLength(1); expect(rows[0]!.installation.canonicalSource).toEqual(source)
    expect(rows[0]!.installation.organizationId).toBeUndefined()
    expect(await readFile(join(rows[0]!.path, 'SKILL.md'), 'utf8')).toContain('name: same-slug')
  }))
  it('same slug personal/enterprise/account/space never collide and exact uninstall retains every neighbor', async () => owned(async root => {
    const tuples: CanonicalSkillSource[] = [source, { ...source, subjectKind: 'enterprise_instance', subjectId: 'instance-i' }, { ...source, accountId: 'account-b' }, { ...source, productSpaceId: 'space-b' }]
    for (const [i, tuple] of tuples.entries()) expect((await install(root, tuple, bytes(`Distinct ${i}`))).result.success).toBe(true)
    expect(new Set(tuples.map(tuple => canonicalSkillRoot(root, tuple))).size).toBe(4)
    const removed = await uninstallCreatorSkill({ workspaceRoot: canonicalSkillRoot(root, source), workspaceId: 'workspace-a', operationId: randomUUID(), slug: 'same-slug' })
    expect(removed.success).toBe(true)
    for (let i = 1; i < tuples.length; i++) expect(await readFile(join(canonicalSkillRoot(root, tuples[i]!), 'skills/same-slug/SKILL.md'), 'utf8')).toContain(`Distinct ${i}`)
  }))
  it('checksum or exact size mismatch never publishes ledger or files', async () => owned(async root => {
    await expect(install(root, source, bytes(), { checksum: 'f'.repeat(64) })).rejects.toThrow('checksum')
    await expect(install(root, source, bytes(), { sizeBytes: bytes().byteLength + 1 })).rejects.toThrow('size')
    expect(await readCanonicalSkillInstallations(root, source)).toEqual([])
  }))
  it('modified bytes are unknown even when ledger and installation admission remain', async () => owned(async root => {
    expect((await install(root)).result.success).toBe(true)
    await writeFile(join(canonicalSkillRoot(root, source), 'skills/same-slug/SKILL.md'), 'modified')
    expect(await readCanonicalSkillInstallations(root, source)).toEqual([])
  }))
  it('scope directory symlink cannot redirect a native write', async () => owned(async root => {
    const foreign = await mkdtemp(join(tmpdir(), 'polo-canonical-skill-neighbor-'))
    try { await mkdir(join(root, '.polo')); await symlink(foreign, join(root, '.polo/canonical-skills')); await expect(install(root)).rejects.toThrow('local directory'); expect(await readCanonicalSkillInstallations(root, source)).toEqual([]) }
    finally { await rm(foreign, { recursive: true, force: true }) }
  }))
})

it('new exact version has a different execution path and never hot-replaces the already installed bytes', async () => owned(async root => {
  expect((await install(root, source, bytes('Pinned K1'))).result.success).toBe(true)
  const newer = { ...source, versionId: 'version-k2' }
  expect((await install(root, newer, bytes('New K2'), { version: '1.1.0' })).result.success).toBe(true)
  expect(canonicalSkillRoot(root, source)).not.toBe(canonicalSkillRoot(root, newer))
  expect(await readFile(join(canonicalSkillRoot(root, source), 'skills/same-slug/SKILL.md'), 'utf8')).toContain('Pinned K1')
  expect(await readFile(join(canonicalSkillRoot(root, newer), 'skills/same-slug/SKILL.md'), 'utf8')).toContain('New K2')
  expect(await readCanonicalSkillInstallations(root, source)).toHaveLength(2)
}))

it('changing ledger digest and files together cannot detach their authority from the original archive checksum', async () => owned(async root => {
  expect((await install(root)).result.success).toBe(true)
  const isolated = canonicalSkillRoot(root, source)
  const { scanCreatorSkillDirectory } = await import('../archive.ts')
  await writeFile(join(isolated, 'skills/same-slug/SKILL.md'), '---\nname: same-slug\ndescription: Changed content.\n---\nForged content.\n')
  const changed = await scanCreatorSkillDirectory(join(isolated, 'skills/same-slug'))
  const ledger = JSON.parse(await readFile(join(isolated, 'creator-skills.json'), 'utf8'))
  ledger.installed[0].contentDigest = changed.contentDigest
  await writeFile(join(isolated, 'creator-skills.json'), JSON.stringify(ledger))
  expect(await readCanonicalSkillInstallations(root, source)).toEqual([])
}))

it('canonical startup recovery only cleans abandoned preparation inside its original version root', async () => owned(async root => {
  const { recoverCanonicalSkillOperations, ensureCanonicalSkillRoot } = await import('../canonical.ts')
  const isolated = await ensureCanonicalSkillRoot(root, source)
  const operationId = randomUUID(), operation = join(isolated, '.creator-skill-ops', operationId)
  await mkdir(join(operation, 'stage'), { recursive: true })
  await writeFile(join(operation, 'archive.zip'), 'interrupted download')
  await writeFile(join(operation, 'journal.json'), JSON.stringify({ schemaVersion: 1, operationId, action: 'install', slug: 'same-slug', targetPath: join(isolated, 'skills/same-slug'), transactionBackupPath: join(operation, 'backup'), ledgerPath: join(isolated, 'creator-skills.json'), oldLedger: null, state: 'preparing' }))
  await mkdir(join(root, 'other-owned-project')); await writeFile(join(root, 'other-owned-project/keep.txt'), 'keep')
  await recoverCanonicalSkillOperations(root)
  const { access } = await import('node:fs/promises')
  await expect(access(operation)).rejects.toThrow()
  expect(await readFile(join(root, 'other-owned-project/keep.txt'), 'utf8')).toBe('keep')
  expect(await readCanonicalSkillInstallations(root, source)).toEqual([])
}))

it('same immutable version identity refuses different checksum before a second native mutation', async () => owned(async root => {
  expect((await install(root, source, bytes('Original immutable bytes'))).result.success).toBe(true)
  await expect(install(root, source, bytes('Different bytes'), {replaceExisting:true})).rejects.toThrow('cannot be replaced')
  expect(await readFile(join(canonicalSkillRoot(root, source), 'skills/same-slug/SKILL.md'), 'utf8')).toContain('Original immutable bytes')
}))

it('concurrent prepared downloads cannot overwrite an immutable canonical version under the real ledger lock', async () => owned(async root => {
  let markLocked!: () => void, release!: () => void
  const locked = new Promise<void>(resolve => { markLocked = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  const original = bytes('First winner'), changed = bytes('Concurrent changed bytes')
  const input = (content: Uint8Array) => ({workspaceId:'workspace-a',operationId:randomUUID(),source,version:'1.0.0',downloadUrl:'https://authority.example/download',expiresAt:'2030-01-01T00:00:00.000Z',checksum:createHash('sha256').update(content).digest('hex'),sizeBytes:content.length,replaceExisting:true})
  const first = installCanonicalSkill(root,input(original),{fetch:(async()=>new Response(original)) as unknown as typeof fetch,onLedgerMutationLocked:async()=>{markLocked();await barrier}})
  await locked
  // The second adapter observes no committed ledger. Its real download then
  // releases the first operation; the shared native lock must decide safely.
  const second = installCanonicalSkill(root,input(changed),{fetch:(async()=>{release();return new Response(changed)}) as unknown as typeof fetch})
  try {
    expect((await first).success).toBe(true);expect((await second).success).toBe(false)
    expect(await readFile(join(canonicalSkillRoot(root,source),'skills/same-slug/SKILL.md'),'utf8')).toContain('First winner')
  } finally { release();await Promise.allSettled([first,second]) }
}))

it('canonical native ledger lock revalidates the original permission after waiting before commit', async () => owned(async root => {
 const content=bytes('Must not publish after revocation');let allowed=true, checks=0
 const result=await installCanonicalSkill(root,{workspaceId:'workspace-a',operationId:randomUUID(),source,version:'1.0.0',downloadUrl:'https://authority.example/download',expiresAt:'2030-01-01T00:00:00.000Z',checksum:createHash('sha256').update(content).digest('hex'),sizeBytes:content.length},{fetch:(async()=>new Response(content)) as unknown as typeof fetch,assertCommitAllowed:async()=>{checks++;if(!allowed)throw new Error('Original authority revoked')},onLedgerMutationLocked:async()=>{allowed=false}})
 expect(checks).toBe(2);expect(result.success).toBe(false);expect(await readCanonicalSkillInstallations(root,source)).toEqual([])
}))

it('enterprise display versions survive native ledger reload and uninstall backup', async () => owned(async root => {
  const enterprise = { ...source, subjectKind: 'enterprise_instance' as const }
  expect((await install(root, enterprise, bytes(), {version:'release-1'})).result.success).toBe(true)
  const rows = await readCanonicalSkillInstallations(root, source)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.installation.version).toBe('release-1')
  const removed = await uninstallCreatorSkill({workspaceRoot:canonicalSkillRoot(root,enterprise),workspaceId:'workspace-a',operationId:randomUUID(),slug:'same-slug'})
  expect(removed.success).toBe(true)
  const { listCreatorSkillBackups } = await import('../installer.ts')
  expect((await listCreatorSkillBackups(canonicalSkillRoot(root,enterprise)))[0]?.version).toBe('release-1')
}))
it('a server-authorized package above the default limit remains installable within absolute native safety caps', async () => owned(async root => {
  const content = zipSync({'same-slug/SKILL.md':strToU8('---\nname: same-slug\ndescription: Large approved package.\n---\nInstructions.'),'same-slug/references/data.bin':new Uint8Array(21*1024*1024)},{level:0})
  expect((await install(root,source,content)).result.success).toBe(true)
  expect(await readCanonicalSkillInstallations(root,source)).toHaveLength(1)
}))

it('absolute native archive caps remain enforced for canonical server grants', async () => owned(async root => {
  await expect(install(root,source,bytes(),{sizeBytes:100*1024*1024+1})).rejects.toThrow('bundle is invalid')
  expect(await readCanonicalSkillInstallations(root,source)).toEqual([])
}))
