import { expect, test } from 'bun:test'
import { createBackend } from '../factory'

test('managed billing rejects unsupported backend before constructing a direct provider runtime', () => {
  expect(() => createBackend({ provider: 'anthropic', managedBilling: { beforeSend: async () => { throw new Error('unused') } } } as any)).toThrow('Managed Polo billing requires the Pi backend')
})
