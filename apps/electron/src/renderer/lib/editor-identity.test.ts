import { describe, expect, it } from 'bun:test'

const { editorIdentityId } = await import('./editor-identity')

describe('editorIdentityId (Edit Popover owner identity)', () => {
  it('is deterministic for the same label + filePath', () => {
    const a = editorIdentityId('Permissions', '/Users/alice/project/config.json')
    const b = editorIdentityId('Permissions', '/Users/alice/project/config.json')
    expect(a).toBe(b)
  })

  it('has a fixed short length regardless of path depth (deep legal paths included)', () => {
    const deepPath = `/Users/alice/${'deep/'.repeat(60)}config.json`
    expect(deepPath.length).toBeGreaterThan(200)
    const id = editorIdentityId('Permissions', deepPath)
    expect(id).toMatch(/^ep-[0-9a-f]{16}$/)
    expect(id.length).toBeLessThan(40)
    // Deterministic for the deep path too
    expect(editorIdentityId('Permissions', deepPath)).toBe(id)
  })

  it('distinguishes label/path pairs (no concatenation ambiguity)', () => {
    // "ab"+"c" must never equal "a"+"bc"
    expect(editorIdentityId('ab', 'c/x')).not.toBe(editorIdentityId('a', 'bc/x'))
    expect(editorIdentityId('Permissions', '/a/config.json'))
      .not.toBe(editorIdentityId('Automations', '/a/config.json'))
    expect(editorIdentityId('Permissions', '/a/config.json'))
      .not.toBe(editorIdentityId('Permissions', '/b/config.json'))
  })
})
