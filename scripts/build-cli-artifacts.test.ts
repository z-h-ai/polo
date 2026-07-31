import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const repoRoot = join(import.meta.dir, '..')
const buildScript = join(import.meta.dir, 'build-cli-artifacts.ts')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function buildArtifacts(outputDir: string): void {
  const result = Bun.spawnSync([
    process.execPath,
    'run',
    buildScript,
    '--allow-test-output-override',
  ], {
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

  it('fails redirected production build and dist before stale default validation', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'polo-cli-production-redirect-'))
    roots.push(outputDir)
    const defaultManifestPath = join(
      repoRoot,
      'apps',
      'electron',
      'dist',
      'cli',
      'artifact-manifest.json',
    )
    const defaultManifest = existsSync(defaultManifestPath)
      ? readFileSync(defaultManifestPath)
      : null

    for (const productionScript of ['electron:build', 'electron:dist']) {
      const redirectedOutput = join(outputDir, productionScript.replace(':', '-'))
      const result = Bun.spawnSync([process.execPath, 'run', productionScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          POLO_AI_CLI_ARTIFACT_OUTPUT_DIR: redirectedOutput,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const diagnostics = result.stdout.toString() + result.stderr.toString()

      expect(result.exitCode).not.toBe(0)
      expect(diagnostics).toContain('production electron:build/electron:dist fail closed')
      expect(existsSync(join(redirectedOutput, 'cli'))).toBe(false)
      if (defaultManifest) {
        expect(readFileSync(defaultManifestPath).equals(defaultManifest)).toBe(true)
      }
    }
  })
})
