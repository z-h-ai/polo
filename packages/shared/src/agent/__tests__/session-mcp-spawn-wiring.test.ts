/**
 * Session MCP spawn-spec wiring (review fix rounds 9-10, issue B): the
 * resolved backend runtime carries the PRODUCTION per-turn spawn-spec builder
 * for the packaged session MCP server — desktop turns get the capability flag
 * + generation, non-desktop turns fail closed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBackendRuntimePaths } from '../backend/internal/runtime-resolver.ts'
import type { BackendHostRuntimeContext } from '../backend/types.ts'

// A fake runtime root containing the packaged server at the dev-layout path
// (resolveServerPath walks upwards looking for
// `packages/session-mcp-server/dist/index.js`).
let hostRoot: string
let hostRuntime: BackendHostRuntimeContext

beforeEach(() => {
  hostRoot = mkdtempSync(join(tmpdir(), 'session-mcp-spawn-'))
  const serverDist = join(hostRoot, 'packages', 'session-mcp-server', 'dist')
  mkdirSync(serverDist, { recursive: true })
  writeFileSync(join(serverDist, 'index.js'), '// stub packaged server')
  hostRuntime = { appRootPath: hostRoot, isPackaged: false }
})

afterEach(() => {
  rmSync(hostRoot, { recursive: true, force: true })
})

describe('session MCP spawn-spec wiring (resolved runtime)', () => {
  it('desktop turn: the resolved runtime builds a complete spawn spec (capability + generation)', () => {
    const paths = resolveBackendRuntimePaths(hostRuntime)
    expect(paths.buildSessionMcpServerInvocation).toBeDefined()
    expect(paths.sessionServerPath).toBeDefined()

    const build = paths.buildSessionMcpServerInvocation!
    const invocation = build({
      sessionId: 'turn-1',
      workspaceRootPath: hostRuntime.appRootPath,
      plansFolderPath: '/plans',
      allowRequestUserInput: true,
      turnGeneration: 42,
    })
    expect(invocation).not.toBeNull()
    // command = the resolved node runtime; args = the packaged server + turn args
    expect(invocation!.command).toBe(paths.nodeRuntimePath!)
    expect(invocation!.args[0]).toBe(paths.sessionServerPath)
    expect(invocation!.args).toContain('--allow-request-user-input')
    expect(invocation!.args[invocation!.args.indexOf('--turn-generation') + 1]!).toBe('42')
    expect(invocation!.args[invocation!.args.indexOf('--session-id') + 1]!).toBe('turn-1')
  })

  it('non-desktop turn: the resolved runtime builds a fail-closed spawn spec (no capability args)', () => {
    const paths = resolveBackendRuntimePaths(hostRuntime)
    const build2 = paths.buildSessionMcpServerInvocation!
    const invocation = build2({
      sessionId: 'turn-2',
      workspaceRootPath: hostRuntime.appRootPath,
      plansFolderPath: '/plans',
    })
    expect(invocation).not.toBeNull()
    expect(invocation!.args).not.toContain('--allow-request-user-input')
    expect(invocation!.args).not.toContain('--turn-generation')
  })
})
