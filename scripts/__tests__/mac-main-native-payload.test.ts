import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { validateMacMainNativePayload } = require('../../apps/electron/scripts/packaged-cli-layout.cjs')

describe('Mac App main native dependencies', () => {
  it('rejects missing sharp or libvips payloads before shipping a broken App CLI entry', () => {
    const resources = mkdtempSync(join(tmpdir(), 'polo-mac-native-'))
    const img = join(resources, 'app', 'node_modules', '@img')
    try {
      expect(() => validateMacMainNativePayload(resources, 'arm64')).toThrow('native dependency is missing')
      for (const file of [
        'sharp-darwin-arm64/package.json',
        'sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
        'sharp-libvips-darwin-arm64/package.json',
        'sharp-libvips-darwin-arm64/lib/index.js',
      ]) {
        mkdirSync(dirname(join(img, file)), { recursive: true })
        writeFileSync(join(img, file), '')
      }
      expect(() => validateMacMainNativePayload(resources, 'arm64')).toThrow('libvips library is missing')
      writeFileSync(join(img, 'sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib'), '')
      expect(() => validateMacMainNativePayload(resources, 'arm64')).not.toThrow()
      expect(() => validateMacMainNativePayload(resources, 'x64')).toThrow('native dependency is missing')
    } finally {
      rmSync(resources, { recursive: true, force: true })
    }
  })

  it('stages target-architecture native packages and gates the final App layout', () => {
    const root = join(import.meta.dir, '..', '..')
    const builder = readFileSync(join(root, 'apps/electron/electron-builder.yml'), 'utf8')
    expect(builder).toContain('from: ../../node_modules/@img/sharp-darwin-${arch}')
    expect(builder).toContain('from: ../../node_modules/@img/sharp-libvips-darwin-${arch}')
    const hook = readFileSync(join(root, 'apps/electron/scripts/afterPack.cjs'), 'utf8')
    expect(hook).toContain('if (isMac) validateMacMainNativePayload(resourcesDir, expectedArch)')
  })
})
