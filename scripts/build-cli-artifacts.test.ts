import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const repoRoot = join(import.meta.dir, '..')
const buildScript = join(import.meta.dir, 'build-cli-artifacts.ts')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function buildArtifacts(outputDir: string): void {
  const result = Bun.spawnSync([process.execPath, 'run', buildScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      POLO_AI_CLI_ARTIFACT_OUTPUT_DIR: outputDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString())
  }
}

describe('packaged CLI artifact reproducibility', () => {
  it('writes identical manifest bytes for consecutive builds with unchanged inputs', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'polo-cli-artifacts-'))
    roots.push(outputDir)
    const manifestPath = join(outputDir, 'cli', 'artifact-manifest.json')

    buildArtifacts(outputDir)
    const firstManifest = readFileSync(manifestPath)
    buildArtifacts(outputDir)
    const secondManifest = readFileSync(manifestPath)

    expect(secondManifest.equals(firstManifest)).toBe(true)
    expect(JSON.parse(secondManifest.toString())).not.toHaveProperty('generatedAt')
  })
})
