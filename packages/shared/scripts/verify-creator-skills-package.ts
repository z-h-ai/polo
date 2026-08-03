import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
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

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const packageName = '@z-h-ai/shared'
const packageVersion = '0.11.0'
const registry = 'https://npm.pkg.github.com'
const requiredEntries = [
  'dist/creator-skills/index.cjs',
  'dist/creator-skills/index.d.ts',
  'dist/creator-skills/fixtures.cjs',
  'dist/creator-skills/fixtures.d.ts',
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
  keepTemp: boolean
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
    if (arg === '--output-dir' || arg === '--tarball') {
      const value = argv[index + 1]
      assert(value && !value.startsWith('--'), `${arg} requires a path`)
      if (arg === '--output-dir') options.outputDir = resolve(value)
      else options.tarball = resolve(value)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  assert(!(options.outputDir && options.tarball), '--output-dir and --tarball cannot be combined')
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

async function waitForRoute(url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      const body = await response.text()
      if (response.ok) return JSON.parse(body) as Record<string, unknown>
      lastError = new Error(`unexpected response status ${response.status}: ${body}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
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

  const forbidden = paths.filter(path => (
    path.startsWith('src/creator-skills/')
    || path === 'src/creator-skills.public.d.ts'
    || path === 'src/creator-skills.fixtures.public.d.ts'
    || path.startsWith('tests/')
    || path.includes('/__tests__/')
    || /(?:^|\/)[^/]+\.(?:test|isolated)\.[cm]?[jt]sx?$/.test(path)
  ))
  assert(forbidden.length === 0, `tarball leaked private source/tests: ${forbidden.join(', ')}`)

  const tracked = new Set(
    (gitOutput(['ls-files', '--', 'packages/shared']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map(path => path.replace(/^packages\/shared\//, '')),
  )
  const unexpectedUntracked = paths.filter(path => (
    path !== 'package.json'
    && !path.startsWith('dist/creator-skills/')
    && !tracked.has(path)
  ))
  assert(
    unexpectedUntracked.length === 0,
    `tarball contains untracked manual artifacts: ${unexpectedUntracked.join(', ')}`,
  )
}

async function packPackage(outputDir: string): Promise<{ tarball: string; summary: PackSummary }> {
  await mkdir(outputDir, { recursive: true })
  const result = await runCommandCapture('npm', [
    'pack',
    '--json',
    '--pack-destination',
    outputDir,
  ], { cwd: packageRoot })
  if (result.stderr) process.stderr.write(result.stderr)
  const summaries = JSON.parse(result.stdout.trim()) as PackSummary[]
  assert(summaries.length === 1, 'npm pack did not return exactly one tarball')
  const summary = summaries[0]!
  validatePackManifest(summary.files)
  return { tarball: join(outputDir, summary.filename), summary }
}

async function inspectExtractedPackage(
  tarball: string,
  tempRoot: string,
  manifest?: PackManifestEntry[],
): Promise<void> {
  const extractRoot = join(tempRoot, 'tarball-extract')
  await mkdir(extractRoot)
  await runCommand('tar', ['-xzf', tarball, '-C', extractRoot])
  const extractedRoot = join(extractRoot, 'package')
  const packageJson = JSON.parse(await readFile(join(extractedRoot, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    publishConfig?: { registry?: string }
    exports?: Record<string, unknown>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  assert(packageJson.name === packageName, `expected package name ${packageName}`)
  assert(packageJson.version === packageVersion, `expected package version ${packageVersion}`)
  assert(packageJson.publishConfig?.registry === registry, `publish registry must be ${registry}`)
  assert(packageJson.exports?.['./creator-skills'], 'creator-skills export is missing')
  assert(packageJson.exports?.['./creator-skills/fixtures'], 'creator-skills fixtures export is missing')

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
  const paths = manifest?.map(entry => entry.path) ?? await listFiles(extractedRoot)
  for (const path of paths) {
    const fullPath = join(extractedRoot, path)
    const file = await readFile(fullPath)
    for (const needle of forbiddenBytes) {
      assert(!file.includes(needle), `tarball file ${path} contains a developer/worktree path`)
    }
  }
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

async function prepareConsumer(tempRoot: string, tarball: string): Promise<string> {
  const consumerRoot = join(tempRoot, 'standalone-next-consumer')
  const artifactsRoot = join(consumerRoot, 'artifacts')
  const routeRoot = join(consumerRoot, 'src', 'app', 'api', 'shared-skill-proof')
  await mkdir(artifactsRoot, { recursive: true })
  await mkdir(routeRoot, { recursive: true })
  const localTarball = join(artifactsRoot, basename(tarball))
  await copyFile(tarball, localTarball)

  await writeFile(join(consumerRoot, '.npmrc'), 'registry=https://registry.npmjs.org\n')
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
      [packageName]: `file:artifacts/${basename(tarball)}`,
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
  validateCreatorSkillContent,
  type SkillVersionMetadata,
} from '${packageName}/creator-skills'
import {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_SLUG,
} from '${packageName}/creator-skills/fixtures'

const metadata: SkillVersionMetadata = CREATOR_SKILL_FIXTURE_METADATA
const validation = validateCreatorSkillContent(
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_SLUG,
)
if (!validation.valid || !metadata.name) throw new Error('fixture validation failed')
if (calculateContentDigest(CREATOR_SKILL_FIXTURE_MANIFEST) !== CREATOR_SKILL_FIXTURE_CONTENT_DIGEST) {
  throw new Error('fixture content digest drifted')
}
`)
  await writeFile(join(routeRoot, 'route.ts'), `import {
  calculateContentDigest,
  validateCreatorSkillContent,
} from '${packageName}/creator-skills'
import {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  CREATOR_SKILL_FIXTURE_MANIFEST,
  CREATOR_SKILL_FIXTURE_METADATA,
  CREATOR_SKILL_FIXTURE_SLUG,
} from '${packageName}/creator-skills/fixtures'

export const runtime = 'nodejs'

export async function GET() {
  const validation = validateCreatorSkillContent(
    CREATOR_SKILL_FIXTURE_CONTENT,
    CREATOR_SKILL_FIXTURE_SLUG,
  )
  const digest = calculateContentDigest(CREATOR_SKILL_FIXTURE_MANIFEST)
  return Response.json({
    valid: validation.valid,
    slug: CREATOR_SKILL_FIXTURE_SLUG,
    name: CREATOR_SKILL_FIXTURE_METADATA.name,
    digest,
    digestMatches: digest === CREATOR_SKILL_FIXTURE_CONTENT_DIGEST,
  })
}
`)
  return consumerRoot
}

async function proveNodeEntrypoints(consumerRoot: string): Promise<void> {
  const commonJsProof = String.raw`
    const assert = require('node:assert/strict');
    const shared = require('${packageName}/creator-skills');
    const fixtures = require('${packageName}/creator-skills/fixtures');
    const mainPath = require.resolve('${packageName}/creator-skills');
    const fixturePath = require.resolve('${packageName}/creator-skills/fixtures');
    assert.match(mainPath, /\/dist\/creator-skills\/index\.cjs$/);
    assert.match(fixturePath, /\/dist\/creator-skills\/fixtures\.cjs$/);
    assert.equal(shared.validateCreatorSkillContent(fixtures.CREATOR_SKILL_FIXTURE_CONTENT, fixtures.CREATOR_SKILL_FIXTURE_SLUG).valid, true);
    assert.deepEqual(fixtures.CREATOR_SKILL_FIXTURE_METADATA, shared.CREATOR_SKILL_FIXTURE_METADATA);
    assert.equal(shared.calculateContentDigest(fixtures.CREATOR_SKILL_FIXTURE_MANIFEST), fixtures.CREATOR_SKILL_FIXTURE_CONTENT_DIGEST);
    console.log(JSON.stringify({ mainPath, fixturePath, digest: fixtures.CREATOR_SKILL_FIXTURE_CONTENT_DIGEST }));
  `
  await runCommand('node', ['-e', commonJsProof], { cwd: consumerRoot })

  const esmProof = `
    import assert from 'node:assert/strict';
    import { validateCreatorSkillContent } from '${packageName}/creator-skills';
    import { CREATOR_SKILL_FIXTURE_CONTENT, CREATOR_SKILL_FIXTURE_SLUG } from '${packageName}/creator-skills/fixtures';
    assert.equal(validateCreatorSkillContent(CREATOR_SKILL_FIXTURE_CONTENT, CREATOR_SKILL_FIXTURE_SLUG).valid, true);
  `
  await runCommand('node', ['--input-type=module', '-e', esmProof], { cwd: consumerRoot })
}

async function proveNextProductionRoute(consumerRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand('npm', ['run', 'build'], { cwd: consumerRoot, env })
  const port = await getFreePort()
  const child = spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: consumerRoot,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  try {
    const response = await waitForRoute(`http://127.0.0.1:${port}/api/shared-skill-proof`)
    assert(response.valid === true, 'Next route did not validate the shared fixture')
    assert(response.slug === 'review-helper', 'Next route fixture slug drifted')
    assert(response.name === 'Review Helper', 'Next route fixture metadata drifted')
    assert(response.digestMatches === true, 'Next route fixture contentDigest drifted')
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(resolvePromise => {
      const timeout = setTimeout(resolvePromise, 10_000)
      child.once('close', () => {
        clearTimeout(timeout)
        resolvePromise()
      })
    })
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

async function writeEvidence(
  outputDir: string,
  tarball: string,
  summary: PackSummary | undefined,
  consumerRoot: string,
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
      `${packageName}/creator-skills`,
      `${packageName}/creator-skills/fixtures`,
    ],
    compatibility: {
      node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
      typescript: '6.0.3',
      next: '16.2.7',
      nextBundler: 'turbopack',
    },
    checks: {
      npmCiFrozenInstall: 'passed',
      commonJsRequire: 'passed',
      esmImport: 'passed',
      typescriptNoEmit: 'passed',
      nextProductionBuild: 'passed',
      nextProductionRoute: 'passed',
      fixtureCanonicalDigest: 'passed',
      negativeTarballBoundary: 'passed',
    },
  }
  await writeFile(join(outputDir, 'proof.json'), `${JSON.stringify(evidence, null, 2)}\n`)
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
    const packed = options.tarball
      ? { tarball: options.tarball, summary: undefined }
      : await packPackage(outputDir)
    await access(packed.tarball)
    if (packed.summary) validatePackManifest(packed.summary.files)
    await inspectExtractedPackage(packed.tarball, tempRoot, packed.summary?.files)
    const consumerRoot = await prepareConsumer(tempRoot, packed.tarball)
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
    await proveNodeEntrypoints(consumerRoot)
    await runCommand('npm', ['run', 'typecheck'], { cwd: consumerRoot, env: cleanEnv })
    await proveNextProductionRoute(consumerRoot, cleanEnv)
    await writeEvidence(outputDir, packed.tarball, packed.summary, consumerRoot)
    if (process.env.CI && !options.tarball) {
      const status = gitOutput(['status', '--porcelain', '--untracked-files=no']) ?? ''
      assert(status.length === 0, `prepack output is not reproducible from the checked-out snapshot:\n${status}`)
    }
    console.log(`Clean consumer proof passed: ${packed.tarball}`)
    if (options.keepTemp) console.log(`Temporary consumer retained at ${tempRoot}`)
  } finally {
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
