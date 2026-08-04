import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const distRoot = join(packageRoot, 'dist')
const stageRoot = join(distRoot, 'publish')
const stagedDistRoot = join(stageRoot, 'dist', 'creator-skills')

type PackageIdentity = {
  name?: string
  version?: string
  private?: boolean
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function main(): Promise<void> {
  const developmentManifest = await readJson(join(packageRoot, 'package.json')) as PackageIdentity
  const publishManifest = await readJson(join(packageRoot, 'package.publish.json')) as PackageIdentity

  if (
    developmentManifest.name !== publishManifest.name
    || developmentManifest.version !== publishManifest.version
  ) {
    throw new Error('package.json and package.publish.json name/version must match')
  }
  if (developmentManifest.private !== true || publishManifest.private !== undefined) {
    throw new Error('development manifest must be private and publish manifest must be publishable')
  }

  await rm(stageRoot, { recursive: true, force: true })
  await mkdir(stagedDistRoot, { recursive: true })

  for (const filename of [
    'archive.d.ts',
    'fixtures.cjs',
    'fixtures.d.ts',
    'index.cjs',
    'index.d.ts',
    'installer.d.ts',
    'ledger.d.ts',
    'schemas.d.ts',
    'skill-content.d.ts',
    'types.d.ts',
  ]) {
    await copyFile(
      join(distRoot, 'creator-skills', filename),
      join(stagedDistRoot, filename),
    )
  }

  await writeFile(
    join(stageRoot, 'package.json'),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
  )
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
