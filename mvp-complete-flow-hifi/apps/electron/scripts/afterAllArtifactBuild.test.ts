import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.path)
const hook = require('./afterAllArtifactBuild.cjs') as {
  notarizeMacDmgArtifacts: (
    artifacts: string[],
    options: {
      env: NodeJS.ProcessEnv
      run: (command: string, args: string[]) => { status: number }
    },
  ) => void
}

const macNotaryEnv = {
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'fixture-password',
  APPLE_TEAM_ID: 'ABCDE12345',
}

describe('outer macOS DMG notarization', () => {
  it('submits and staples only DMG artifacts before release validation', () => {
    const calls: Array<[string, string[]]> = []
    hook.notarizeMacDmgArtifacts(
      ['/tmp/Polo-AI-arm64.dmg', '/tmp/Polo-AI-arm64.zip'],
      {
        env: macNotaryEnv,
        run(command, args) {
          calls.push([command, args])
          return { status: 0 }
        },
      },
    )

    expect(calls).toEqual([
      [
        'xcrun',
        [
          'notarytool', 'submit', '/tmp/Polo-AI-arm64.dmg',
          '--apple-id', 'release@example.com',
          '--password', 'fixture-password',
          '--team-id', 'ABCDE12345',
          '--wait',
        ],
      ],
      ['xcrun', ['stapler', 'staple', '/tmp/Polo-AI-arm64.dmg']],
    ])
  })

  it('fails closed when release credentials or a DMG are absent', () => {
    expect(() => hook.notarizeMacDmgArtifacts([], { env: macNotaryEnv, run: () => ({ status: 0 }) }))
      .toThrow('did not produce a DMG')
    expect(() => hook.notarizeMacDmgArtifacts(['/tmp/Polo-AI-x64.dmg'], {
      env: { ...macNotaryEnv, APPLE_TEAM_ID: '' },
      run: () => ({ status: 0 }),
    })).toThrow('teamId')
  })
})
