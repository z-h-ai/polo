import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const sharedPackageName = '@polo-ai/shared'
const defaultAdminSourceRoot = '/Users/wow/project/z-h-ai/polo-admin-dir/dev'
const proofRoutePath = 'src/app/shared-skill-proof/page.tsx'

type PackSummary = {
  filename: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
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

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }

    child.stdout.on('data', chunk => {
      process.stdout.write(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      process.stderr.write(chunk)
    })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'null'}${stderr ? `\n${stderr}` : ''}`))
    })
  })
}

async function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'null'}${stderr ? `\n${stderr}` : ''}`))
    })
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(closeError => {
          if (closeError) {
            rejectPromise(closeError)
            return
          }
          resolvePromise(port)
        })
        return
      }
      rejectPromise(new Error('Could not allocate a free port'))
    })
  })
}

async function waitForRoute(url: string, expectedFragments: string[]): Promise<string> {
  const deadline = Date.now() + 120_000
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      const body = await response.text()
      if (response.ok && expectedFragments.every(fragment => body.includes(fragment))) {
        return body
      }
      lastError = new Error(`unexpected response status ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function extractGitArchive(sourceRoot: string, destinationRoot: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const git = spawn('git', ['-C', sourceRoot, 'archive', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const tar = spawn('tar', ['-x', '-C', destinationRoot], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })

    assert(git.stdout, 'git archive stdout stream is unavailable')
    assert(tar.stdin, 'tar extract stdin stream is unavailable')
    git.stdout.pipe(tar.stdin)

    let gitExitCode: number | null = null
    let tarExitCode: number | null = null

    const finish = () => {
      if (gitExitCode === 0 && tarExitCode === 0) {
        resolvePromise()
      } else if (gitExitCode !== null && gitExitCode !== 0) {
        rejectPromise(new Error(`git archive exited with ${gitExitCode}`))
      } else if (tarExitCode !== null && tarExitCode !== 0) {
        rejectPromise(new Error(`tar extract exited with ${tarExitCode}`))
      }
    }

    git.on('error', rejectPromise)
    tar.on('error', rejectPromise)
    git.on('close', code => {
      gitExitCode = code
      if (tar.stdin.writable) tar.stdin.end()
      finish()
    })
    tar.on('close', code => {
      tarExitCode = code
      finish()
    })
  })
}

async function buildSharedPackage(tempRoot: string): Promise<string> {
  await runCommand('bun', ['run', 'build:creator-skills'], {
    cwd: packageRoot,
  })

  const packDestination = join(tempRoot, 'pack')
  await mkdir(packDestination, { recursive: true })
  const packOutput = await runCommandCapture('npm', [
    'pack',
    '--json',
    '--pack-destination',
    packDestination,
  ], {
    cwd: packageRoot,
  })
  const packSummary = JSON.parse(packOutput.stdout.trim()) as PackSummary[]
  assert(packSummary.length === 1, 'npm pack did not return exactly one tarball')

  const tarballPath = join(packDestination, packSummary[0]!.filename)
  const archiveEntries = (await runCommandCapture('tar', ['-tf', tarballPath])).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
  const expectedEntries = [
    'package/dist/creator-skills/index.cjs',
    'package/dist/creator-skills/index.d.ts',
    'package/dist/creator-skills/fixtures.cjs',
    'package/dist/creator-skills/fixtures.d.ts',
  ]
  for (const entry of expectedEntries) {
    assert(archiveEntries.includes(entry), `tarball is missing ${entry}`)
  }

  return tarballPath
}

async function prepareAdminConsumer(
  tempRoot: string,
  tarballPath: string,
): Promise<string> {
  const adminSourceRoot = process.env.POLO_ADMIN_SOURCE_ROOT ?? defaultAdminSourceRoot
  await access(join(adminSourceRoot, 'package.json'))

  const consumerRoot = join(tempRoot, 'admin-consumer')
  await mkdir(consumerRoot, { recursive: true })
  await extractGitArchive(adminSourceRoot, consumerRoot)
  await rm(join(consumerRoot, 'package-lock.json'), { force: true })

  const packageJsonPath = join(consumerRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    [sharedPackageName]: `file:${tarballPath}`,
  }
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

  const proofRouteFile = join(consumerRoot, proofRoutePath)
  await mkdir(dirname(proofRouteFile), { recursive: true })
  await writeFile(
    proofRouteFile,
    `import {
  CREATOR_SKILL_FIXTURE_CONTENT,
  CREATOR_SKILL_FIXTURE_METADATA,
} from "@polo-ai/shared/creator-skills/fixtures";
import { validateCreatorSkillContent } from "@polo-ai/shared/creator-skills";

const validation = validateCreatorSkillContent(CREATOR_SKILL_FIXTURE_CONTENT, "review-helper");

export default function SharedSkillProofPage() {
  return (
    <main>
      <h1>{CREATOR_SKILL_FIXTURE_METADATA.name}</h1>
      <p>{validation.valid ? "valid" : "invalid"}</p>
      <p>{CREATOR_SKILL_FIXTURE_METADATA.description}</p>
    </main>
  );
}
`,
  )

  return consumerRoot
}

async function installConsumerDependencies(consumerRoot: string): Promise<void> {
  await runCommand('npm', [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ], {
    cwd: consumerRoot,
  })
}

async function proveNextRouteCompiles(consumerRoot: string): Promise<void> {
  const port = await getFreePort()
  const env = {
    ...process.env,
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  }
  const child = spawn('npm', [
    'run',
    'dev',
    '--',
    '--turbopack',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: consumerRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
    process.stdout.write(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
    process.stderr.write(chunk)
  })

  try {
    const body = await waitForRoute(`http://127.0.0.1:${port}/shared-skill-proof`, [
      CREATOR_SKILL_PROOF_MARKER,
      CREATOR_SKILL_FIXTURE_MARKER,
    ])
    assert(body.includes('Review Helper'), 'Next proof route did not render the fixture metadata')
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolvePromise => {
      child.once('close', resolvePromise)
    })
  }

  if (stderr && /error/i.test(stderr) && !/ready/i.test(stdout)) {
    throw new Error(`Next proof emitted errors:\n${stderr}`)
  }
}

const CREATOR_SKILL_PROOF_MARKER = 'valid'
const CREATOR_SKILL_FIXTURE_MARKER = 'Review Helper'

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'polo-shared-creator-skills-'))
  try {
    const tarballPath = await buildSharedPackage(tempRoot)
    const consumerRoot = await prepareAdminConsumer(tempRoot, tarballPath)
    await installConsumerDependencies(consumerRoot)
    await proveNextRouteCompiles(consumerRoot)
    console.log('Creator Skills package verification passed.')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
