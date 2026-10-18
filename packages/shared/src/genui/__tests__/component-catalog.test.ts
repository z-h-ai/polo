import { describe, expect, test } from 'bun:test'
import {
  GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
} from '@polo-ai/session-tools-core'
import {
  GENUI_BUILTIN_COMPONENT_VERSION,
  GenUiComponentCatalog,
  __resetGenUiComponentCatalogForTests,
  canonicalGenUiJson,
  computeGenUiSchemaHash,
  createBuiltinGenUiComponentCatalog,
  getGenUiComponentCatalog,
  validateGenUiComponentBundle,
  type GenUiComponentBundle,
} from '../component-catalog'

const registration = (overrides: Partial<Parameters<GenUiComponentCatalog['register']>[0]> = {}) => ({
  type: 'third-party-gauge',
  name: 'Third-party gauge',
  description: 'a gauge component',
  source: 'catalog' as const,
  version: '1.0.0',
  schemaVersion: 1,
  schemaHash: 'a'.repeat(64),
  loader: 'webview-sandbox' as const,
  capabilities: [],
  interactive: false,
  ...overrides,
})

describe('GenUiComponentCatalog registry', () => {
  test('registers, looks up and lists in insertion order', () => {
    const catalog = new GenUiComponentCatalog()
    expect(catalog.register(registration({ type: 'alpha' }))).toEqual({ ok: true })
    expect(catalog.register(registration({ type: 'beta' }))).toEqual({ ok: true })
    expect(catalog.list().map(c => c.type)).toEqual(['alpha', 'beta'])
    expect(catalog.has('alpha')).toBe(true)
    expect(catalog.get('alpha')?.source).toBe('catalog')
    expect(catalog.size).toBe(2)
  })

  test('rejects type slugs that could collide with paths or markup', () => {
    const catalog = new GenUiComponentCatalog()
    for (const type of ['', 'Upper', 'has space', 'slash/type', 'dot.name', 'x'.repeat(65)]) {
      const verdict = catalog.register(registration({ type }))
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.error).toContain('Invalid component type')
    }
    expect(catalog.size).toBe(0)
  })

  test('rejects duplicate registration (the type discriminator is the registry key)', () => {
    const catalog = new GenUiComponentCatalog()
    catalog.register(registration({ type: 'alpha' }))
    const verdict = catalog.register(registration({ type: 'alpha', name: 'Other' }))
    expect(verdict.ok).toBe(false)
    expect(catalog.get('alpha')?.name).toBe('Third-party gauge')
  })

  test('descriptors() expose exactly the model-side index fields', () => {
    const catalog = new GenUiComponentCatalog()
    catalog.register(registration({ type: 'alpha' }))
    expect(catalog.descriptors()).toEqual([
      { type: 'alpha', description: 'a gauge component', interactive: false },
    ])
  })
})

describe('canonicalGenUiJson / schema hash', () => {
  test('sorts keys and drops undefined so formatting churn cannot rotate a hash', () => {
    expect(canonicalGenUiJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalGenUiJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalGenUiJson([{ b: 1, a: 0 }])).toBe('[{"a":0,"b":1}]')
  })

  test('equal schemas hash equal; different schemas hash differently', () => {
    const a = { type: 'object', properties: { x: { type: 'string' } } }
    const reordered = { properties: { x: { type: 'string' } }, type: 'object' }
    expect(computeGenUiSchemaHash(a)).toBe(computeGenUiSchemaHash(reordered))
    expect(computeGenUiSchemaHash(a)).not.toBe(computeGenUiSchemaHash({ ...a, description: 'drift' }))
  })
})

describe('builtin catalog', () => {
  test('registers the six builtins through the same interface as third-party', () => {
    const catalog = createBuiltinGenUiComponentCatalog()
    expect(catalog.size).toBe(6)
    for (const descriptor of GENUI_BUILTIN_COMPONENT_DESCRIPTORS) {
      const component = catalog.get(descriptor.type)!
      expect(component).toBeDefined()
      expect(component.source).toBe('builtin')
      expect(component.version).toBe(GENUI_BUILTIN_COMPONENT_VERSION)
      expect(component.schemaVersion).toBe(1)
      expect(component.loader).toBe('builtin-react')
      expect(component.capabilities).toEqual([])
      expect(component.schemaHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('builtin interactive flags mirror the session-tools-core descriptors', () => {
    const catalog = createBuiltinGenUiComponentCatalog()
    for (const descriptor of GENUI_BUILTIN_COMPONENT_DESCRIPTORS) {
      expect(catalog.get(descriptor.type)!.interactive).toBe(descriptor.interactive)
      expect(catalog.get(descriptor.type)!.description).toBe(descriptor.description)
    }
  })

  test('schema hashes are stable across builds and distinct across components', () => {
    const first = createBuiltinGenUiComponentCatalog()
    const second = createBuiltinGenUiComponentCatalog()
    const hashesA = first.list().map(c => c.schemaHash)
    const hashesB = second.list().map(c => c.schemaHash)
    expect(hashesA).toEqual(hashesB)
    expect(new Set(hashesA).size).toBe(hashesA.length)
  })

  test('singleton is stable; the test seam resets it', () => {
    __resetGenUiComponentCatalogForTests()
    const first = getGenUiComponentCatalog()
    expect(getGenUiComponentCatalog()).toBe(first)
    __resetGenUiComponentCatalogForTests()
    expect(getGenUiComponentCatalog()).not.toBe(first)
    __resetGenUiComponentCatalogForTests()
  })
})

describe('validateGenUiComponentBundle', () => {
  const bundle: GenUiComponentBundle = {
    manifest: {
      name: 'Gauge',
      type: 'gauge',
      schemaVersion: 1,
      capabilities: [],
      version: '1.0.0',
    },
    schema: { type: 'object' },
    renderer: { entry: 'index.html', sandbox: 'webview' },
  }

  test('accepts a well-formed webview-sandbox bundle', () => {
    expect(validateGenUiComponentBundle(bundle)).toEqual({ ok: true, bundle })
  })

  test('rejects malformed manifests', () => {
    for (const [label, mutate] of [
      ['no manifest', () => ({ ...bundle, manifest: undefined })],
      ['empty name', () => ({ bundle, manifest: { ...bundle.manifest, name: '' } })],
      ['bad type slug', () => ({ ...bundle, manifest: { ...bundle.manifest, type: 'Bad_Type' } })],
      ['schemaVersion 0', () => ({ ...bundle, manifest: { ...bundle.manifest, schemaVersion: 0 } })],
      ['non-string capability', () => ({ ...bundle, manifest: { ...bundle.manifest, capabilities: [1] } })],
      ['missing version', () => ({ ...bundle, manifest: { ...bundle.manifest, version: '' } })],
    ] as const) {
      const verdict = validateGenUiComponentBundle(mutate())
      expect(verdict.ok, label).toBe(false)
    }
  })

  test('only the webview sandbox is sanctioned (never the renderer process)', () => {
    const verdict = validateGenUiComponentBundle({
      ...bundle,
      renderer: { entry: 'index.html', sandbox: 'iframe' as unknown as 'webview' },
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toContain('webview sandbox')
  })

  test('rejects missing schema and malformed tokenMapping', () => {
    expect(validateGenUiComponentBundle({ ...bundle, schema: undefined }).ok).toBe(false)
    expect(validateGenUiComponentBundle({ ...bundle, schema: [1, 2] }).ok).toBe(false)
    expect(validateGenUiComponentBundle({ ...bundle, tokenMapping: 'no' }).ok).toBe(false)
    expect(validateGenUiComponentBundle({ ...bundle, tokenMapping: { 'bg': 'color.surface' } }).ok).toBe(true)
  })
})
