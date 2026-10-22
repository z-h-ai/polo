import { describe, expect, it } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { validateProductionCreatorAppBundle } from '../creator-app-publishing.ts'
import { validatePoloAppManifestContract } from '../../protocol/local-app-manifest.ts'

const base = { schemaVersion: 1, appId: 'cross-surface-app', version: '1.0.0', runtime: 'static', entry: ['index.html'], healthcheck: '/', webPath: '/', permissions: [] }
function bundle(changes: Record<string, unknown>, files: Record<string, string>) {
  return zipSync(Object.fromEntries(Object.entries({ ...files, 'polo-app.json': JSON.stringify({ ...base, ...changes }) }).map(([name, content]) => [name, strToU8(content)])))
}
describe('cross-surface App manifest regressions', () => {
  it('uses archived index.html for the runtime-supported static directory', () => {
    expect(validateProductionCreatorAppBundle(bundle({ entry: ['dist'] }, { 'dist/index.html': '<!doctype html>' })).entry).toEqual(['dist'])
  })
  it('keeps literal process arguments and checks only the executable file', () => {
    expect(validateProductionCreatorAppBundle(bundle({ runtime: 'js', entry: ['server/index.js', '--label', 'team report'] }, { 'server/index.js': 'console.log(1)' })).entry).toEqual(['server/index.js', '--label', 'team report'])
  })
  it('defaults an omitted landing path consistently on desktop', () => {
    expect(validatePoloAppManifestContract({ ...base, webPath: undefined }).webPath).toBe('/')
  })
  it('supports the enterprise display-name contract on desktop', () => {
    expect(validatePoloAppManifestContract({ ...base, name: '企'.repeat(512) }).name).toBe('企'.repeat(512))
  })
  it.each(['/\\example.com/health', '/bad\u0000path'])('rejects a non-loopback health path %j', (healthcheck) => {
    expect(() => validatePoloAppManifestContract({ ...base, healthcheck })).toThrow()
  })
})
