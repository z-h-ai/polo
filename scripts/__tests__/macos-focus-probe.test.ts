import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const probe = join(
  import.meta.dir,
  '..',
  '..',
  'apps',
  'electron',
  'scripts',
  'macos-running-app-state.jxa',
)

describe('macOS full-validation frontmost probe', () => {
  it.skipIf(process.platform !== 'darwin')(
    'reports the native frontmost NSRunningApplication',
    () => {
      const frontmost = Bun.spawnSync([
        '/usr/bin/osascript',
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("AppKit"); String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)',
      ])
      expect(frontmost.exitCode).toBe(0)
      const pid = frontmost.stdout.toString().trim()
      expect(pid).toMatch(/^[1-9]\d*$/)

      const result = Bun.spawnSync([
        '/usr/bin/osascript',
        '-l',
        'JavaScript',
        probe,
        pid,
      ])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        active: true,
        frontmost: true,
        frontmostPid: Number(pid),
        terminated: false,
      })
    },
  )
})
