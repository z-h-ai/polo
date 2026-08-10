import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isStrictSemVer } from '../src/admin/semver.ts'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const distRoot = join(packageRoot, 'dist')
const stageRoot = join(distRoot, 'publish')
const stagedDistRoot = join(stageRoot, 'dist', 'creator-skills')
const stagedAdminDistRoot = join(stageRoot, 'dist', 'admin')

type PackageIdentity = {
  name?: string
  version?: string
  private?: boolean
}

type PackageManifest = PackageIdentity & Record<string, unknown>

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function main(): Promise<void> {
  const developmentManifest = await readJson(join(packageRoot, 'package.json')) as PackageManifest
  const publishManifest = await readJson(join(packageRoot, 'package.publish.json')) as PackageManifest

  if (
    publishManifest.name !== '@z-h-ai/shared'
    || typeof publishManifest.version !== 'string'
    || !isStrictSemVer(publishManifest.version)
  ) {
    throw new Error('publish manifest must target @z-h-ai/shared with a valid SemVer version')
  }
  if (publishManifest.private !== undefined) {
    throw new Error('publish manifest must be publishable')
  }
  const publishConfig = publishManifest.publishConfig as Record<string, unknown> | undefined
  if (publishConfig?.registry !== 'https://npm.pkg.github.com') {
    throw new Error('publish manifest must target GitHub Packages')
  }
  const developmentExports = developmentManifest.exports as Record<string, unknown> | undefined
  const publishExports = publishManifest.exports as Record<string, unknown> | undefined
  for (const subpath of ['./creator-skills', './creator-skills/fixtures', './creator-skills/metadata', './creator-app-publishing']) {
    const developmentExport = developmentExports?.[subpath] as Record<string, unknown> | undefined
    const publishExport = publishExports?.[subpath] as Record<string, unknown> | undefined
    for (const condition of ['types', 'browser', 'import', 'default']) {
      if (developmentExport?.[condition] !== publishExport?.[condition]) {
        throw new Error(`package.json and package.publish.json export ${subpath} ${condition} must match`)
      }
    }
  }

  await rm(stageRoot, { recursive: true, force: true })
  await mkdir(stagedDistRoot, { recursive: true })
  await mkdir(stagedAdminDistRoot, { recursive: true })

  for (const filename of [
    'archive.d.ts',
    'fixtures.cjs',
    'fixtures.d.ts',
    'index.cjs',
    'index.d.ts',
    'installer.d.ts',
    'ledger.d.ts',
    'metadata.browser.cjs',
    'metadata.browser.mjs',
    'metadata.d.ts',
    'schemas.d.ts',
    'skill-content.d.ts',
    'types.d.ts',
  ]) {
    await copyFile(
      join(distRoot, 'creator-skills', filename),
      join(stagedDistRoot, filename),
    )
  }

  for (const filename of ['creator-app-publishing.cjs', 'creator-app-publishing.browser.cjs', 'creator-app-publishing.d.ts']) {
    await copyFile(
      join(distRoot, 'admin', filename),
      join(stagedAdminDistRoot, filename),
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
