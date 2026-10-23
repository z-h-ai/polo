import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.path)
const hook = require('./afterSign.cjs') as {
  stapleAppBundle: (
    context: {
      appOutDir: string
      packager?: { appInfo?: { productFilename?: string } }
    },
    options: {
      run: (command: string, args: string[]) =>
        { status: number | null; stdout?: string; stderr?: string; error?: Error }
    },
  ) => string
}

const context = {
  appOutDir: '/tmp/release/macos',
  packager: { appInfo: { productFilename: 'Polo AI' } },
}

function staplerResult(args: string[]): { status: number; stdout: string; stderr: string } {
  if (args[1] === 'staple') {
    return { status: 0, stdout: 'The staple and validate action worked!', stderr: '' }
  }
  return { status: 70, stdout: '', stderr: 'code object is not signed at all' }
}

describe('pre-target macOS App stapling', () => {
  it('keeps the existing ticket when the bundle already validates', () => {
    const calls: Array<[string, string[]]> = []
    const appBundle = hook.stapleAppBundle(context, {
      run(_command, args) {
        calls.push([_command, args])
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    expect(appBundle).toBe('/tmp/release/macos/Polo AI.app')
    expect(calls).toEqual([['xcrun', ['stapler', 'validate', '/tmp/release/macos/Polo AI.app']]])
  })

  it('staples when validation finds no ticket and fails closed on errors', () => {
    const calls: Array<[string, string[]]> = []
    const appBundle = hook.stapleAppBundle(context, {
      run(command, args) {
        calls.push([command, args])
        return staplerResult(args)
      },
    })

    expect(appBundle).toBe('/tmp/release/macos/Polo AI.app')
    expect(calls).toEqual([
      ['xcrun', ['stapler', 'validate', '/tmp/release/macos/Polo AI.app']],
      ['xcrun', ['stapler', 'staple', '/tmp/release/macos/Polo AI.app']],
    ])
    expect(() =>
      hook.stapleAppBundle(context, {
        run: (_command, _args) => ({ status: 1, stdout: '', stderr: 'staple worker error' }),
      }),
    ).toThrow('stapling failed')
  })
})
