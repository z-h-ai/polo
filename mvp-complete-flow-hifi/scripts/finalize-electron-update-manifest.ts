import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

const MACOS_UPDATE_ARTIFACTS = [
  'Polo-AI-x64.zip',
  'Polo-AI-x64.dmg',
] as const
const MACOS_UPDATE_PATH = 'Polo-AI-x64.zip'

interface UpdateFile {
  url: string
  sha512: string
  size: number
  [key: string]: unknown
}

interface MacUpdateManifest {
  version: string
  files: UpdateFile[]
  path: string
  sha512: string
  [key: string]: unknown
}

function parseMacUpdateManifest(contents: string): MacUpdateManifest {
  const parsed = load(contents)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('latest-mac.yml must be a YAML object')
  }
  const manifest = parsed as Partial<MacUpdateManifest>
  if (
    typeof manifest.version !== 'string'
    || !Array.isArray(manifest.files)
    || manifest.path !== MACOS_UPDATE_PATH
    || typeof manifest.sha512 !== 'string'
  ) {
    throw new Error('latest-mac.yml does not use the macOS x64 ZIP update contract')
  }
  const names = manifest.files.map((entry) => entry?.url)
  if (
    manifest.files.length !== MACOS_UPDATE_ARTIFACTS.length
    || names.some(name => typeof name !== 'string')
    || new Set(names).size !== names.length
    || MACOS_UPDATE_ARTIFACTS.some(name => !names.includes(name))
  ) {
    throw new Error(
      `latest-mac.yml must reference exactly: ${MACOS_UPDATE_ARTIFACTS.join(', ')}`,
    )
  }
  for (const entry of manifest.files) {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof entry.url !== 'string'
      || typeof entry.sha512 !== 'string'
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
    ) {
      throw new Error('latest-mac.yml contains an invalid file entry')
    }
  }
  return manifest as MacUpdateManifest
}

async function sha512(path: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function finalArtifact(path: string): Promise<{ sha512: string, size: number }> {
  if (!(await lstat(path)).isFile()) {
    throw new Error(`Final updater artifact must be a regular file: ${path}`)
  }
  const [digest, metadata] = await Promise.all([sha512(path), stat(path)])
  return { sha512: digest, size: metadata.size }
}

/**
 * electron-builder calculates the DMG update metadata before the custom
 * afterAllArtifactBuild hook staples the outer DMG. Stapling changes the DMG
 * bytes, while electron-builder writes its cached latest-mac.yml only after
 * the hook returns. Refresh the manifest after electron-builder has fully
 * exited so every digest and size describes the immutable upload bytes.
 */
export async function finalizeMacUpdateManifest(releaseDir: string): Promise<void> {
  const manifestPath = join(releaseDir, 'latest-mac.yml')
  const original = await readFile(manifestPath, 'utf8')
  const manifest = parseMacUpdateManifest(original)
  const finalized = new Map<string, { sha512: string, size: number }>()

  for (const name of MACOS_UPDATE_ARTIFACTS) {
    finalized.set(name, await finalArtifact(join(releaseDir, name)))
  }
  for (const entry of manifest.files) {
    const artifact = finalized.get(entry.url)
    if (!artifact) throw new Error(`latest-mac.yml references an unsupported artifact: ${entry.url}`)
    entry.sha512 = artifact.sha512
    entry.size = artifact.size
  }
  manifest.sha512 = finalized.get(MACOS_UPDATE_PATH)!.sha512

  const temporaryPath = `${manifestPath}.finalizing-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporaryPath, dump(manifest, { lineWidth: -1, noRefs: true }), {
      flag: 'wx',
    })
    await rename(temporaryPath, manifestPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}
