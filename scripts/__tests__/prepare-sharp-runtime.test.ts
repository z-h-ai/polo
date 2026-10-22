import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Host-only install: the target packages must be produced from the lock,
// without assuming npm's optional dependencies installed the opposite CPU.
for (const arch of ['x64', 'arm64'] as const) test(`prepares locked Mac sharp/libvips for ${arch} from a host-only tree`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'polo-sharp-'))
  try {
    const addon = `@img/sharp-darwin-${arch}`, vips = `@img/sharp-libvips-darwin-${arch}`
    mkdirSync(join(root, 'node_modules/sharp'), { recursive: true })
    writeFileSync(join(root, 'node_modules/sharp/package.json'), JSON.stringify({ name: 'sharp', version: '0.34.5', optionalDependencies: { [addon]: '0.34.5', [vips]: '1.2.4' } }))
    writeFileSync(join(root, 'bun.lock'), JSON.stringify({ packages: { sharp: ['sharp@0.34.5', '', {}, 'sha512-core'], [addon]: [`${addon}@0.34.5`, '', {}, 'sha512-addon'], [vips]: [`${vips}@1.2.4`, '', {}, 'sha512-vips'] } }))
    const { prepareMacSharpRuntime } = await import('../prepare-platform-runtime') as any
    const packed: string[] = []
    await prepareMacSharpRuntime(root, arch, async (name: string, version: string, integrity: string, destination: string) => {
      packed.push(`${name}@${version}`)
      expect(integrity).toBe(name === addon ? 'sha512-addon' : 'sha512-vips')
      mkdirSync(join(destination, 'lib'), { recursive: true })
      writeFileSync(join(destination, 'package.json'), JSON.stringify({ name, version, os: ['darwin'], cpu: [arch] }))
      if (name === addon) writeFileSync(join(destination, 'lib', `sharp-darwin-${arch}.node`), 'target-addon')
      else { writeFileSync(join(destination, 'lib/index.js'), ''); writeFileSync(join(destination, 'lib/libvips-cpp.test.dylib'), 'target-vips') }
    })
    expect(packed).toEqual([`${addon}@0.34.5`, `${vips}@1.2.4`])
    expect(JSON.parse(readFileSync(join(root, 'node_modules', addon, 'package.json'), 'utf8')).version).toBe('0.34.5')
    await prepareMacSharpRuntime(root, arch, async () => { throw new Error('valid prepared resources should be reused') })
    writeFileSync(join(root, 'node_modules', addon, 'package.json'), JSON.stringify({ name: addon, version: 'stale' }))
    await expect(prepareMacSharpRuntime(root, arch, async () => { throw new Error('stale native package must be replaced') })).rejects.toThrow('stale native package must be replaced')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
