import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proveManagedRouteProcess } from './managed-route-process.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const publishStageRoot = join(packageRoot, 'dist', 'publish')
const publishManifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.publish.json'), 'utf8'),
) as { name: string; version: string }
const packageName = publishManifest.name
const packageVersion = publishManifest.version
const registry = 'https://npm.pkg.github.com'
const requiredEntries = [
  'dist/admin/creator-app-publishing.cjs',
  'dist/admin/creator-app-publishing.browser.cjs',
  'dist/admin/creator-app-publishing.d.ts',
  'dist/creator-skills/archive.d.ts',
  'dist/creator-skills/fixtures.cjs',
  'dist/creator-skills/fixtures.d.ts',
  'dist/creator-skills/index.cjs',
  'dist/creator-skills/index.d.ts',
  'dist/creator-skills/installer.d.ts',
  'dist/creator-skills/ledger.d.ts',
  'dist/creator-skills/metadata.browser.cjs',
  'dist/creator-skills/metadata.browser.mjs',
  'dist/creator-skills/metadata.d.ts',
  'dist/creator-skills/schemas.d.ts',
  'dist/creator-skills/skill-content.d.ts',
  'dist/creator-skills/types.d.ts',
] as const

type PackManifestEntry = {
  path: string
  size: number
}

type PackSummary = {
  filename: string
  integrity: string
  shasum: string
  files: PackManifestEntry[]
}

type CliOptions = {
  outputDir?: string
  tarball?: string
  registryVersion?: string
  publishedMetadata?: string
  keepTemp: boolean
}

type ConsumerSource =
  | { kind: 'tarball'; tarball: string }
  | { kind: 'registry'; version: string; publishedMetadata: string }

type PublishedPackageMetadata = {
  name?: string
  version?: string
  'dist.tarball'?: string
  'dist.integrity'?: string
  'dist.shasum'?: string
}

type ProcessLifecycleEvidence = {
  command: string
  terminationSignal: 'SIGTERM'
  forcedKill: boolean
  shutdownDurationMs: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { keepTemp: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep-temp') {
      options.keepTemp = true
      continue
    }
    if (
      arg === '--output-dir'
      || arg === '--tarball'
      || arg === '--registry-version'
      || arg === '--published-metadata'
    ) {
      const value = argv[index + 1]
      assert(value && !value.startsWith('--'), `${arg} requires a value`)
      if (arg === '--output-dir') options.outputDir = resolve(value)
      else if (arg === '--tarball') options.tarball = resolve(value)
      else if (arg === '--registry-version') options.registryVersion = value
      else options.publishedMetadata = resolve(value)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  assert(!(options.outputDir && options.tarball), '--output-dir and --tarball cannot be combined')
  assert(
    !(options.tarball && options.registryVersion),
    '--tarball and --registry-version cannot be combined',
  )
  assert(
    options.registryVersion ? Boolean(options.publishedMetadata) : !options.publishedMetadata,
    '--registry-version and --published-metadata must be provided together',
  )
  if (options.registryVersion) {
    assert(
      options.registryVersion === packageVersion,
      `registry proof version must match package manifest version ${packageVersion}`,
    )
  }
  return options
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''

    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)

    child.stdout.on('data', chunk => process.stdout.write(chunk))
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      process.stderr.write(chunk)
    })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(
        `${command} ${args.join(' ')} failed with exit code ${code ?? 'null'}`
        + (stderr ? `\n${stderr}` : ''),
      ))
    })
  })
}

async function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else rejectPromise(new Error(
        `${command} ${args.join(' ')} failed with exit code ${code ?? 'null'}`
        + (stderr ? `\n${stderr}` : ''),
      ))
    })
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert(address && typeof address === 'object', 'Could not allocate a free port')
      server.close(error => error ? rejectPromise(error) : resolvePromise(address.port))
    })
  })
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function gitOutput(args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

function validatePackManifest(manifest: PackManifestEntry[]): void {
  const paths = manifest.map(entry => entry.path)
  for (const requiredEntry of requiredEntries) {
    assert(paths.includes(requiredEntry), `tarball is missing ${requiredEntry}`)
  }

  const allowed = new Set<string>(['package.json', ...requiredEntries])
  const unexpectedUntracked = paths.filter(path => !allowed.has(path))
  assert(
    unexpectedUntracked.length === 0,
    `tarball contains files outside the publish-only boundary: ${unexpectedUntracked.join(', ')}`,
  )
  assert(paths.length === allowed.size, 'tarball must contain only its manifest and built public entries')
}

async function packPackage(outputDir: string): Promise<{ tarball: string; summary: PackSummary }> {
  await mkdir(outputDir, { recursive: true })
  await runCommand('bun', ['run', 'prepack'], { cwd: packageRoot })
  const result = await runCommandCapture('npm', [
    'pack',
    '--json',
    '--pack-destination',
    outputDir,
  ], { cwd: publishStageRoot })
  if (result.stderr) process.stderr.write(result.stderr)
  const summaries = JSON.parse(result.stdout.trim()) as PackSummary[]
  assert(summaries.length === 1, 'npm pack did not return exactly one tarball')
  const summary = summaries[0]!
  validatePackManifest(summary.files)
  return { tarball: join(outputDir, summary.filename), summary }
}

async function inspectPackageDirectory(
  packageDirectory: string,
  manifest?: PackManifestEntry[],
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    private?: boolean
    publishConfig?: { registry?: string }
    exports?: Record<string, unknown>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  assert(packageJson.name === packageName, `expected package name ${packageName}`)
  assert(packageJson.version === packageVersion, `expected package version ${packageVersion}`)
  assert(packageJson.private !== true, 'staged package must be publishable')
  assert(packageJson.publishConfig?.registry === registry, `publish registry must be ${registry}`)
  const exports = packageJson.exports ?? {}
  assert(exports['.'], 'package root export is missing')
  assert(exports['./creator-skills'], 'creator-skills export is missing')
  assert(exports['./creator-skills/fixtures'], 'creator-skills fixtures export is missing')
  assert(exports['./creator-skills/metadata'], 'creator-skills metadata export is missing')
  assert(exports['./creator-app-publishing'], 'creator-app-publishing export is missing')
  assert(
    Object.keys(exports).sort().join('\n') === '.\n./creator-app-publishing\n./creator-skills\n./creator-skills/fixtures\n./creator-skills/metadata',
    'published package must expose only the package root and four supported public subpaths',
  )
  const exportTargets = Object.values(exports).flatMap(value => (
    typeof value === 'string'
      ? [value]
      : Object.values(value as Record<string, unknown>).filter(target => typeof target === 'string') as string[]
  ))
  assert(
    exportTargets.every(target => !target.includes('/src/')),
    'published exports must not point to private source',
  )
  assert(
    exportTargets.every(target => !target.endsWith('.ts') || target.endsWith('.d.ts')),
    'published runtime exports must not point to TypeScript source',
  )
  const browserMetadataBundle = await readFile(
    join(packageDirectory, 'dist', 'creator-skills', 'metadata.browser.mjs'),
    'utf8',
  )
  assert(
    !/node:(?:crypto|fs|path|zlib|stream)|require\(['"](?:crypto|fs|path|zlib|stream)['"]\)/.test(browserMetadataBundle),
    'browser metadata export must not contain Node-only dependencies',
  )
  assert(!('main' in packageJson), 'published package root must not define main')
  assert(!('types' in packageJson), 'published package root must not define types')

  const dependencySpecs = [
    ...Object.values(packageJson.dependencies ?? {}),
    ...Object.values(packageJson.peerDependencies ?? {}),
  ]
  const workspaceDependencies = dependencySpecs.filter(value => value.startsWith('workspace:'))
  assert(workspaceDependencies.length === 0, 'published package contains workspace:* dependencies')

  const forbiddenBytes = [
    Buffer.from(packageRoot),
    Buffer.from(repositoryRoot),
    Buffer.from('/Users/wow/project/'),
    Buffer.from('file:../../'),
  ]
  const paths = manifest?.map(entry => entry.path) ?? await listFiles(packageDirectory)
  validatePackManifest(paths.map(path => ({ path, size: 0 })))
  for (const path of paths) {
    const fullPath = join(packageDirectory, path)
    const file = await readFile(fullPath)
    for (const needle of forbiddenBytes) {
      assert(!file.includes(needle), `tarball file ${path} contains a developer/worktree path`)
    }
  }
}

async function inspectTarball(
  tarball: string,
  tempRoot: string,
  manifest?: PackManifestEntry[],
): Promise<void> {
  const extractRoot = join(tempRoot, 'tarball-extract')
  await mkdir(extractRoot)
  await runCommand('tar', ['-xzf', tarball, '-C', extractRoot])
  await inspectPackageDirectory(join(extractRoot, 'package'), manifest)
}

async function listFiles(root: string, current = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(join(root, current), { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(root, path))
    else if (entry.isFile()) result.push(path.split(sep).join('/'))
  }
  return result
}

async function prepareConsumer(tempRoot: string, source: ConsumerSource): Promise<string> {
  const consumerRoot = join(tempRoot, 'standalone-next-consumer')
  const routeRoot = join(consumerRoot, 'src', 'app', 'api', 'shared-skill-proof')
  await mkdir(routeRoot, { recursive: true })
  let dependencySpec: string
  let npmConfig = 'registry=https://registry.npmjs.org\n'
  if (source.kind === 'tarball') {
    const artifactsRoot = join(consumerRoot, 'artifacts')
    await mkdir(artifactsRoot, { recursive: true })
    const localTarball = join(artifactsRoot, basename(source.tarball))
    await copyFile(source.tarball, localTarball)
    dependencySpec = `file:artifacts/${basename(source.tarball)}`
  } else {
    assert(process.env.NODE_AUTH_TOKEN, 'registry proof requires NODE_AUTH_TOKEN')
    dependencySpec = source.version
    npmConfig += [
      '@z-h-ai:registry=https://npm.pkg.github.com',
      '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
      '',
    ].join('\n')
  }

  await writeFile(join(consumerRoot, '.npmrc'), npmConfig)
  await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'z-h-ai-shared-clean-consumer-proof',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'next build --turbopack',
      start: 'next start',
    },
    dependencies: {
      [packageName]: dependencySpec,
      next: '16.2.7',
      react: '19.2.7',
      'react-dom': '19.2.7',
    },
    devDependencies: {
      '@types/node': '25.0.8',
      '@types/react': '19.2.16',
      '@types/react-dom': '19.2.3',
      typescript: '6.0.3',
    },
  }, null, 2)}\n`)
  await writeFile(join(consumerRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`)
  await writeFile(join(consumerRoot, 'src', 'type-proof.ts'), `import {
  calculateContentDigest,
  CreatorArtifactUploadCompleteRpcInputSchema,
  CreatorArtifactUploadGrantRpcInputSchema,
  CreatorSkillUploadGrantSchema,
  validateCreatorSkillContent,
  type CreatorSkillUploadGrant,
  type SkillVersionMetadata,
} from '${packageName}/creator-skills'
import {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_SLUG,
} from '${packageName}/creator-skills/fixtures'
import {
  parseCreatorSkillMetadata,
} from '${packageName}/creator-skills/metadata'
import {
  CREATOR_APP_CANONICAL_ENTRIES,
  CREATOR_APP_PAYLOAD_MAX_BYTES,
  analyzeCreatorAppPayload,
  type CreatorAppPayloadEntry,
} from '${packageName}/creator-app-publishing'

const metadata: SkillVersionMetadata = CREATOR_SKILL_FIXTURE_METADATA
const uploadGrant: CreatorSkillUploadGrant = {
  method: 'PUT',
  url: 'https://uploads.example.test/object',
  headers: { 'content-type': 'application/zip' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  uploadGeneration: 1,
  expectedSizeBytes: 123,
  expectedArchiveChecksum: 'a'.repeat(64),
}
if (!CreatorSkillUploadGrantSchema.safeParse(uploadGrant).success) {
  throw new Error('strict upload grant contract failed')
}
const uploadBinding = {
  organizationId: 'organization-id',
  artifactId: 'artifact-id',
  version: '1.0.0',
  sizeBytes: 123,
  archiveChecksum: 'a'.repeat(64),
  idempotencyKey: 'proof-upload-1',
}
if (!CreatorArtifactUploadGrantRpcInputSchema.safeParse(uploadBinding).success) {
  throw new Error('strict upload request contract failed')
}
if (!CreatorArtifactUploadCompleteRpcInputSchema.safeParse({
  ...uploadBinding,
  uploadGeneration: 1,
}).success) throw new Error('strict upload completion contract failed')
const validation = validateCreatorSkillContent(
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_SLUG,
)
if (!validation.valid || !metadata.name) throw new Error('fixture validation failed')
if (parseCreatorSkillMetadata([{
  path: 'review-helper/SKILL.md',
  content: CREATOR_SKILL_FIXTURE_CONTENT,
}]).slug !== CREATOR_SKILL_FIXTURE_SLUG) throw new Error('browser metadata contract failed')
if (calculateContentDigest(CREATOR_SKILL_FIXTURE_MANIFEST) !== CREATOR_SKILL_FIXTURE_CONTENT_DIGEST) {
  throw new Error('fixture content digest drifted')
}
const payloadEntries: CreatorAppPayloadEntry[] = [
  { path: 'index.html', content: '<!doctype html>' },
]
const payloadAnalysis = analyzeCreatorAppPayload(payloadEntries)
if (
  payloadAnalysis.status !== 'ready'
  || payloadAnalysis.candidate.path !== CREATOR_APP_CANONICAL_ENTRIES.static
  || CREATOR_APP_PAYLOAD_MAX_BYTES !== 200 * 1024 * 1024
) throw new Error('Creator App publishing type contract failed')
`)
  await writeFile(join(routeRoot, 'route.ts'), `import {
  calculateContentDigest,
  CreatorArtifactUploadCompleteRpcInputSchema,
  CreatorArtifactUploadGrantRpcInputSchema,
  CreatorSkillUploadGrantSchema,
  validateCreatorSkillContent,
} from '${packageName}/creator-skills'
import {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_SLUG,
} from '${packageName}/creator-skills/fixtures'
import {
  parseCreatorSkillMetadata,
} from '${packageName}/creator-skills/metadata'
import {
  CREATOR_APP_CANONICAL_ENTRIES,
  CREATOR_APP_PAYLOAD_MAX_BYTES,
  analyzeCreatorAppPayload,
} from '${packageName}/creator-app-publishing'

export const runtime = 'nodejs'

export async function GET() {
  const validation = validateCreatorSkillContent(
    CREATOR_SKILL_FIXTURE_CONTENT,
    CREATOR_SKILL_FIXTURE_SLUG,
  )
  const digest = calculateContentDigest(CREATOR_SKILL_FIXTURE_MANIFEST)
  const browserMetadataSlug = parseCreatorSkillMetadata([{
    path: 'review-helper/SKILL.md',
    content: CREATOR_SKILL_FIXTURE_CONTENT,
  }]).slug
  const uploadBinding = {
    organizationId: 'organization-id',
    artifactId: 'artifact-id',
    version: '1.0.0',
    sizeBytes: 123,
    archiveChecksum: 'a'.repeat(64),
    idempotencyKey: 'proof-upload-1',
  }
  const strictUploadV2 = (
    CreatorArtifactUploadGrantRpcInputSchema.safeParse(uploadBinding).success
    && !CreatorArtifactUploadGrantRpcInputSchema.safeParse({
      ...uploadBinding,
      archiveChecksum: undefined,
    }).success
    && CreatorArtifactUploadCompleteRpcInputSchema.safeParse({
      ...uploadBinding,
      uploadGeneration: 1,
    }).success
    && CreatorSkillUploadGrantSchema.safeParse({
      method: 'PUT',
      url: 'https://uploads.example.test/object',
      headers: { 'content-type': 'application/zip' },
      expiresAt: '2030-01-01T00:00:00.000Z',
      uploadGeneration: 1,
      expectedSizeBytes: 123,
      expectedArchiveChecksum: 'a'.repeat(64),
    }).success
  )
  const payloadAnalysis = analyzeCreatorAppPayload([
    { path: 'index.html', content: '<!doctype html>' },
  ])
  const creatorAppPayloadContract = (
    payloadAnalysis.status === 'ready'
    && payloadAnalysis.candidate.path === CREATOR_APP_CANONICAL_ENTRIES.static
    && CREATOR_APP_PAYLOAD_MAX_BYTES === 200 * 1024 * 1024
  )
  return Response.json({
    valid: validation.valid,
    slug: CREATOR_SKILL_FIXTURE_SLUG,
    name: CREATOR_SKILL_FIXTURE_METADATA.name,
    digest,
    digestMatches: digest === CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
    strictUploadV2,
    creatorAppPayloadContract,
    browserMetadataSlug,
  })
}
`)
  const clientProofRoot = join(consumerRoot, 'src', 'app')
  await writeFile(join(clientProofRoot, 'client-proof.tsx'), `'use client'

import { CREATOR_APP_PAYLOAD_MAX_BYTES } from '${packageName}/creator-app-publishing'
import { parseCreatorSkillMetadata } from '${packageName}/creator-skills/metadata'

export function ClientProof() {
  const slug = parseCreatorSkillMetadata([{
    path: 'polo-test/SKILL.md',
    content: '---\\nname: polo-test\\ndescription: Browser-safe export proof.\\n---\\n',
  }]).slug
  return <output data-testid="browser-safe-payload-limit">{CREATOR_APP_PAYLOAD_MAX_BYTES}:{slug}</output>
}
`)
  await writeFile(join(clientProofRoot, 'page.tsx'), `import { ClientProof } from './client-proof'

export default function Page() {
  return <ClientProof />
}
`)
  return consumerRoot
}

async function proveNodeEntrypoints(consumerRoot: string): Promise<void> {
  const commonJsProof = String.raw`
    const assert = require('node:assert/strict');
    const root = require('${packageName}');
    const shared = require('${packageName}/creator-skills');
    const fixtures = require('${packageName}/creator-skills/fixtures');
    const publishing = require('${packageName}/creator-app-publishing');
    const browserMetadata = require('${packageName}/creator-skills/metadata');
    const rootPath = require.resolve('${packageName}');
    const mainPath = require.resolve('${packageName}/creator-skills');
    const fixturePath = require.resolve('${packageName}/creator-skills/fixtures');
    const publishingPath = require.resolve('${packageName}/creator-app-publishing');
    const browserMetadataPath = require.resolve('${packageName}/creator-skills/metadata');
    assert.match(rootPath, /\/dist\/creator-skills\/index\.cjs$/);
    assert.match(mainPath, /\/dist\/creator-skills\/index\.cjs$/);
    assert.match(fixturePath, /\/dist\/creator-skills\/fixtures\.cjs$/);
    assert.match(publishingPath, /\/dist\/admin\/creator-app-publishing\.cjs$/);
    assert.match(browserMetadataPath, /\/dist\/creator-skills\/metadata\.browser\.cjs$/);
    assert.equal(root.validateCreatorSkillContent(fixtures.CREATOR_SKILL_FIXTURE_CONTENT, fixtures.CREATOR_SKILL_FIXTURE_SLUG).valid, true);
    assert.equal(shared.validateCreatorSkillContent(fixtures.CREATOR_SKILL_FIXTURE_CONTENT, fixtures.CREATOR_SKILL_FIXTURE_SLUG).valid, true);
    assert.deepEqual(fixtures.CREATOR_SKILL_FIXTURE_METADATA, shared.CREATOR_SKILL_FIXTURE_METADATA);
    assert.equal(shared.calculateContentDigest(fixtures.CREATOR_SKILL_FIXTURE_MANIFEST), fixtures.CREATOR_SKILL_FIXTURE_CONTENT_DIGEST);
    assert.equal(browserMetadata.parseCreatorSkillMetadata([{ path: 'review-helper/SKILL.md', content: fixtures.CREATOR_SKILL_FIXTURE_CONTENT }]).slug, 'review-helper');
    assert.deepEqual(publishing.CREATOR_APP_CANONICAL_ENTRIES, { static: 'index.html', python: 'server/main.py', js: 'server/index.js' });
    assert.equal(publishing.CREATOR_APP_PAYLOAD_MAX_BYTES, 200 * 1024 * 1024);
    assert.deepEqual(publishing.analyzeCreatorAppPayload([{ path: 'index.html', content: '<!doctype html>' }]), {
      status: 'ready', candidate: { runtime: 'static', path: 'index.html' },
    });
    console.log(JSON.stringify({ rootPath, mainPath, fixturePath, publishingPath, browserMetadataPath, digest: fixtures.CREATOR_SKILL_FIXTURE_CONTENT_DIGEST }));
  `
  await runCommand('node', ['-e', commonJsProof], { cwd: consumerRoot })

  const esmProof = `
    import assert from 'node:assert/strict';
    import { validateCreatorSkillContent as rootValidateCreatorSkillContent } from '${packageName}';
    import { validateCreatorSkillContent } from '${packageName}/creator-skills';
    import { CREATOR_SKILL_FIXTURE_CONTENT, CREATOR_SKILL_FIXTURE_SLUG } from '${packageName}/creator-skills/fixtures';
    import { parseCreatorSkillMetadata } from '${packageName}/creator-skills/metadata';
    import { CREATOR_APP_PAYLOAD_MAX_BYTES, analyzeCreatorAppPayload } from '${packageName}/creator-app-publishing';
    assert.equal(validateCreatorSkillContent(CREATOR_SKILL_FIXTURE_CONTENT, CREATOR_SKILL_FIXTURE_SLUG).valid, true);
    assert.equal(rootValidateCreatorSkillContent(CREATOR_SKILL_FIXTURE_CONTENT, CREATOR_SKILL_FIXTURE_SLUG).valid, true);
    assert.equal(CREATOR_APP_PAYLOAD_MAX_BYTES, 200 * 1024 * 1024);
    assert.equal(analyzeCreatorAppPayload([{ path: 'index.html', content: '<!doctype html>' }]).status, 'ready');
    assert.equal(parseCreatorSkillMetadata([{ path: 'review-helper/SKILL.md', content: CREATOR_SKILL_FIXTURE_CONTENT }]).slug, CREATOR_SKILL_FIXTURE_SLUG);
  `
  await runCommand('node', ['--input-type=module', '-e', esmProof], { cwd: consumerRoot })
}

async function proveUnsupportedEntrypoints(consumerRoot: string): Promise<void> {
  const commonJsProof = String.raw`
    const assert = require('node:assert/strict');
    for (const specifier of [
      '${packageName}/protocol',
      '${packageName}/package.json',
    ]) {
      assert.throws(
        () => require(specifier),
        error => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        specifier + ' must stay outside the published boundary',
      );
    }
  `
  await runCommand('node', ['-e', commonJsProof], { cwd: consumerRoot })

  const esmProof = `
    import assert from 'node:assert/strict';
    for (const specifier of [
      '${packageName}/protocol',
      '${packageName}/package.json',
    ]) {
      await assert.rejects(
        import(specifier),
        error => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        specifier + ' must stay outside the published boundary',
      );
    }
  `
  await runCommand('node', ['--input-type=module', '-e', esmProof], { cwd: consumerRoot })
}

async function proveNextProductionRoute(
  consumerRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ProcessLifecycleEvidence> {
  await runCommand('npm', ['run', 'build'], { cwd: consumerRoot, env })
  const port = await getFreePort()
  const nextCli = join(consumerRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
  await access(nextCli)
  const child = spawn('node', [
    nextCli,
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: consumerRoot,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const { response, lifecycle } = await proveManagedRouteProcess(
    child,
    `http://127.0.0.1:${port}/api/shared-skill-proof`,
    {
      label: 'Next production server',
      earlyExitMessage: 'Next production server exited before the proof route responded',
    },
  )
  assert(response.valid === true, 'Next route did not validate the shared fixture')
  assert(response.slug === 'review-helper', 'Next route fixture slug drifted')
  assert(response.name === 'review-helper', 'Next route fixture metadata drifted')
  assert(response.digestMatches === true, 'Next route fixture contentDigest drifted')
  assert(response.strictUploadV2 === true, 'Next route strict upload v2 contract drifted')
  assert(response.creatorAppPayloadContract === true, 'Next route Creator App payload contract drifted')
  assert(response.browserMetadataSlug === 'review-helper', 'Next route browser metadata contract drifted')
  return {
    command: 'node node_modules/next/dist/bin/next start',
    terminationSignal: 'SIGTERM',
    ...lifecycle,
  }
}

async function writeEvidence(
  outputDir: string,
  tarball: string,
  summary: PackSummary | undefined,
  consumerRoot: string,
  nextProcessLifecycle: ProcessLifecycleEvidence,
): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  const consumerLockPath = join(consumerRoot, 'package-lock.json')
  const lockfile = JSON.parse(await readFile(consumerLockPath, 'utf8')) as {
    packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>
  }
  const installed = lockfile.packages?.[`node_modules/${packageName}`]
  assert(installed?.integrity, 'frozen consumer lockfile is missing shared package integrity')
  await copyFile(consumerLockPath, join(outputDir, 'clean-consumer-package-lock.json'))
  const gitCommit = gitOutput(['rev-parse', 'HEAD']) ?? 'unknown'
  const gitTag = gitOutput(['describe', '--tags', '--exact-match', 'HEAD']) ?? null
  const status = gitOutput(['status', '--porcelain', '--untracked-files=no']) ?? ''
  const evidence = {
    schemaVersion: 1,
    package: `${packageName}@${packageVersion}`,
    registry,
    tarball: basename(tarball),
    tarballSha256: await sha256(tarball),
    npmIntegrity: summary?.integrity ?? installed.integrity,
    npmShasum: summary?.shasum ?? null,
    frozenLockIntegrity: installed.integrity,
    frozenLockResolved: installed.resolved,
    gitCommit,
    gitTag,
    gitSnapshotClean: status.length === 0,
    publicExports: [
      packageName,
      `${packageName}/creator-app-publishing`,
      `${packageName}/creator-skills`,
      `${packageName}/creator-skills/fixtures`,
      `${packageName}/creator-skills/metadata`,
    ],
    compatibility: {
      node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
      typescript: '6.0.3',
      next: '16.2.7',
      nextBundler: 'turbopack',
    },
    nextProductionProcess: nextProcessLifecycle,
    checks: {
      npmCiFrozenInstall: 'passed',
      commonJsRequire: 'passed',
      esmImport: 'passed',
      unsupportedSubpathsRejected: 'passed',
      typescriptNoEmit: 'passed',
      nextProductionBuild: 'passed',
      nextProductionRoute: 'passed',
      nextClientComponentBuild: 'passed',
      nextProductionProcessLifecycle: 'passed',
      fixtureCanonicalDigest: 'passed',
      browserMetadataContract: 'passed',
      strictUploadV2Contract: 'passed',
      creatorAppPayloadContract: 'passed',
      negativeTarballBoundary: 'passed',
    },
  }
  await writeFile(join(outputDir, 'proof.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
}

async function writeRegistryEvidence(
  outputDir: string,
  source: Extract<ConsumerSource, { kind: 'registry' }>,
  consumerRoot: string,
  nextProcessLifecycle: ProcessLifecycleEvidence,
): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  const consumerLockPath = join(consumerRoot, 'package-lock.json')
  const lockfile = JSON.parse(await readFile(consumerLockPath, 'utf8')) as {
    packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>
  }
  const installed = lockfile.packages?.[`node_modules/${packageName}`]
  assert(installed?.version === source.version, 'registry lockfile resolved the wrong shared version')
  assert(installed.integrity, 'registry lockfile is missing shared package integrity')
  assert(
    installed.resolved?.startsWith(`${registry}/download/${packageName}/${source.version}/`),
    `registry lockfile did not resolve ${packageName} from GitHub Packages`,
  )

  const published = JSON.parse(
    await readFile(source.publishedMetadata, 'utf8'),
  ) as PublishedPackageMetadata
  assert(published.name === packageName, 'published metadata has the wrong package name')
  assert(published.version === source.version, 'published metadata has the wrong package version')
  assert(published['dist.integrity'], 'published metadata is missing dist.integrity')
  assert(published['dist.tarball'], 'published metadata is missing dist.tarball')
  assert(
    published['dist.integrity'] === installed.integrity,
    'registry lockfile integrity does not match published metadata',
  )
  assert(
    published['dist.tarball'] === installed.resolved,
    'registry lockfile URL does not match published metadata',
  )

  const candidateProof = JSON.parse(
    await readFile(join(outputDir, 'proof.json'), 'utf8'),
  ) as { npmIntegrity?: string; npmShasum?: string; tarballSha256?: string }
  assert(
    candidateProof.npmIntegrity === published['dist.integrity'],
    'published package integrity does not match the verified candidate tarball',
  )
  if (published['dist.shasum'] && candidateProof.npmShasum) {
    assert(
      candidateProof.npmShasum === published['dist.shasum'],
      'published package shasum does not match the verified candidate tarball',
    )
  }

  await copyFile(
    consumerLockPath,
    join(outputDir, 'registry-clean-consumer-package-lock.json'),
  )
  const releaseTag = `shared-v${source.version}`
  const evidence = {
    schemaVersion: 1,
    package: `${packageName}@${source.version}`,
    source: 'github-packages',
    registry,
    publishedTarball: published['dist.tarball'],
    publishedIntegrity: published['dist.integrity'],
    publishedShasum: published['dist.shasum'] ?? null,
    candidateTarballSha256: candidateProof.tarballSha256 ?? null,
    frozenLockIntegrity: installed.integrity,
    frozenLockResolved: installed.resolved,
    releaseTag,
    releaseCommit: gitOutput(['rev-parse', `${releaseTag}^{}`]) ?? 'unknown',
    proofToolCommit: gitOutput(['rev-parse', 'HEAD']) ?? 'unknown',
    publicExports: [
      packageName,
      `${packageName}/creator-app-publishing`,
      `${packageName}/creator-skills`,
      `${packageName}/creator-skills/fixtures`,
      `${packageName}/creator-skills/metadata`,
    ],
    compatibility: {
      node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
      typescript: '6.0.3',
      next: '16.2.7',
      nextBundler: 'turbopack',
    },
    nextProductionProcess: nextProcessLifecycle,
    checks: {
      githubPackagesResolution: 'passed',
      registryMetadataMatchesCandidateArtifact: 'passed',
      npmCiFrozenInstall: 'passed',
      commonJsRequire: 'passed',
      esmImport: 'passed',
      unsupportedSubpathsRejected: 'passed',
      typescriptNoEmit: 'passed',
      nextProductionBuild: 'passed',
      nextProductionRoute: 'passed',
      nextClientComponentBuild: 'passed',
      nextProductionProcessLifecycle: 'passed',
      fixtureCanonicalDigest: 'passed',
      browserMetadataContract: 'passed',
      strictUploadV2Contract: 'passed',
      creatorAppPayloadContract: 'passed',
      negativeInstalledPackageBoundary: 'passed',
    },
  }
  await writeFile(
    join(outputDir, 'registry-proof.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  console.log(JSON.stringify(evidence, null, 2))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const tempRoot = await mkdtemp(join(tmpdir(), 'z-h-ai-shared-proof-'))
  const outputDir = options.outputDir ?? join(tempRoot, 'proof-artifacts')
  try {
    assert(
      isAbsolute(tempRoot) && relative(repositoryRoot, tempRoot).startsWith(`..${sep}`),
      'clean consumer must be outside the Polo repository',
    )
    let source: ConsumerSource
    let packed: { tarball: string; summary: PackSummary | undefined } | undefined
    if (options.registryVersion && options.publishedMetadata) {
      source = {
        kind: 'registry',
        version: options.registryVersion,
        publishedMetadata: options.publishedMetadata,
      }
    } else {
      packed = options.tarball
        ? { tarball: options.tarball, summary: undefined }
        : await packPackage(outputDir)
      await access(packed.tarball)
      if (packed.summary) validatePackManifest(packed.summary.files)
      await inspectTarball(packed.tarball, tempRoot, packed.summary?.files)
      source = { kind: 'tarball', tarball: packed.tarball }
    }
    const consumerRoot = await prepareConsumer(tempRoot, source)
    const cleanEnv = {
      ...process.env,
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      NPM_CONFIG_USERCONFIG: join(consumerRoot, '.npmrc'),
      npm_config_cache: join(tempRoot, 'npm-cache'),
    }
    await runCommand('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: consumerRoot,
      env: cleanEnv,
    })
    await rm(join(consumerRoot, 'node_modules'), { recursive: true, force: true })
    await runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: consumerRoot, env: cleanEnv })
    if (source.kind === 'registry') {
      await inspectPackageDirectory(join(consumerRoot, 'node_modules', packageName))
    }
    await proveNodeEntrypoints(consumerRoot)
    await proveUnsupportedEntrypoints(consumerRoot)
    await runCommand('npm', ['run', 'typecheck'], { cwd: consumerRoot, env: cleanEnv })
    const nextProcessLifecycle = await proveNextProductionRoute(consumerRoot, cleanEnv)
    if (source.kind === 'registry') {
      await writeRegistryEvidence(outputDir, source, consumerRoot, nextProcessLifecycle)
    } else {
      assert(packed, 'candidate package metadata is missing')
      await writeEvidence(
        outputDir,
        packed.tarball,
        packed.summary,
        consumerRoot,
        nextProcessLifecycle,
      )
    }
    if (
      process.env.CI
      && !process.env.SHARED_PACKAGE_PROOF_ALLOW_DIRTY
      && !options.tarball
      && source.kind === 'tarball'
    ) {
      const status = gitOutput(['status', '--porcelain', '--untracked-files=no']) ?? ''
      assert(status.length === 0, `prepack output is not reproducible from the checked-out snapshot:\n${status}`)
    }
    console.log(
      source.kind === 'registry'
        ? `Registry-backed clean consumer proof passed: ${packageName}@${source.version}`
        : `Clean consumer proof passed: ${source.tarball}`,
    )
    if (options.keepTemp) console.log(`Temporary consumer retained at ${tempRoot}`)
  } finally {
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
