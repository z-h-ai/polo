import { describe, expect, it } from 'bun:test'
import { build } from 'esbuild'
import { join } from 'node:path'

describe('Home recent Apps browser dependency boundary', () => {
  it('bundles the renderer module without the Node-heavy config barrel', async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, '..', 'home-recent-apps.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile.inputs)
      .map(input => input.replaceAll('\\', '/'))

    expect(inputs.some(input =>
      input.endsWith('packages/shared/src/config/home-recent.ts'),
    )).toBe(true)
    expect(inputs.some(input =>
      input.endsWith('packages/shared/src/config/index.ts')
      || input.endsWith('packages/shared/src/config/preferences.ts')
      || input.includes('@anthropic-ai/claude-agent-sdk'),
    )).toBe(false)
  })
})
