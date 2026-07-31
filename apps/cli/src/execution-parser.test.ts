import { describe, expect, it } from 'bun:test'
import {
  UsageError,
  findExecutionCommandIndex,
  parseExecutionArgs,
} from './execution-parser.ts'

const argv = (...args: string[]) => ['bun', 'index.ts', ...args]

describe('execution parser', () => {
  it('parses Codex-style exec flags', () => {
    const result = parseExecutionArgs(argv(
      'exec',
      '--yolo',
      '--json',
      '-m',
      'gpt-5',
      '-C',
      '/tmp',
      'hello',
    ))
    expect(result.kind).toBe('exec')
    expect(result.permissionMode).toBe('allow-all')
    expect(result.json).toBe(true)
    expect(result.model).toBe('gpt-5')
    expect(result.workingDirectory).toBe('/tmp')
    expect(result.prompt).toBe('hello')
  })

  it('defaults exec to safe', () => {
    expect(parseExecutionArgs(argv('exec', 'hello')).permissionMode).toBe('safe')
  })

  it('keeps run multi-word positional behavior', () => {
    const result = parseExecutionArgs(argv('run', 'hello', 'from', 'polo'))
    expect(result.kind).toBe('run')
    expect(result.prompt).toBe('hello from polo')
  })

  it('keeps legacy run flags without allowing workspace registration', () => {
    const result = parseExecutionArgs(argv(
      'run',
      '--workspace-dir',
      '/tmp',
      '--send-timeout',
      '1234',
      '--stdin',
      '--mode',
      'ask',
      'hello',
    ))
    expect(result).toMatchObject({
      workspace: '/tmp',
      workingDirectory: '/tmp',
      sendTimeout: 1234,
      forceStdin: true,
      permissionMode: 'ask',
      prompt: 'hello',
    })
  })

  it('treats reserved names as prompts after --', () => {
    const result = parseExecutionArgs(argv('exec', '--', 'sessions'))
    expect(result.kind).toBe('exec')
    expect(result.prompt).toBe('sessions')
  })

  it('parses resume, --last, sessions and delete', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    expect(parseExecutionArgs(argv('exec', 'resume', id, 'continue'))).toMatchObject({
      kind: 'resume',
      threadId: id,
      prompt: 'continue',
    })
    expect(parseExecutionArgs(argv('exec', 'resume', '--last', 'continue'))).toMatchObject({
      kind: 'resume',
      last: true,
      prompt: 'continue',
    })
    expect(parseExecutionArgs(argv('exec', 'sessions')).kind).toBe('sessions')
    expect(parseExecutionArgs(argv('exec', 'delete', id))).toMatchObject({ kind: 'delete', threadId: id })
    expect(parseExecutionArgs(argv('exec', 'resume', id, '--', 'continue'))).toMatchObject({
      kind: 'resume',
      threadId: id,
      prompt: 'continue',
    })
    expect(() => parseExecutionArgs(argv('exec', 'resume', '--', id))).toThrow('missing thread_id')
    expect(() => parseExecutionArgs(argv('exec', 'delete', '--', id))).toThrow('missing thread_id')
    expect(parseExecutionArgs(argv('exec', 'resume', '--last', '--', id))).toMatchObject({
      kind: 'resume',
      last: true,
      prompt: id,
    })
  })

  it('rejects execution-only options for sessions and delete', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    const cases: Array<[string[], string]> = [
      [argv('exec', 'sessions', '--last'), '--last'],
      [argv('exec', 'sessions', '--yolo'), '--yolo'],
      [argv('exec', 'sessions', '--dangerously-bypass-approvals-and-sandbox'), '--dangerously-bypass-approvals-and-sandbox'],
      [argv('exec', 'sessions', '--model', 'gpt-5'), '--model'],
      [argv('exec', 'sessions', '--provider', 'openai'), '--provider'],
      [argv('exec', 'sessions', '--api-key', 'secret-value'), '--api-key'],
      [argv('exec', 'sessions', '--base-url', 'https://example.test'), '--base-url'],
      [argv('exec', 'sessions', '--ephemeral'), '--ephemeral'],
      [argv('exec', 'sessions', '--timeout', '1000'), '--timeout'],
      [argv('exec', 'delete', id, '--last'), '--last'],
      [argv('exec', 'delete', id, '--yolo'), '--yolo'],
      [argv('exec', 'delete', id, '--model', 'gpt-5'), '--model'],
      [argv('exec', 'delete', id, '--provider', 'openai'), '--provider'],
      [argv('exec', 'delete', id, '--api-key', 'secret-value'), '--api-key'],
      [argv('exec', 'delete', id, '--base-url', 'https://example.test'), '--base-url'],
      [argv('exec', 'delete', id, '--workspace', 'workspace-1'), '--workspace'],
      [argv('exec', 'delete', id, '-C', '/tmp'), '-C'],
    ]
    for (const [value, option] of cases) {
      expect(() => parseExecutionArgs(value)).toThrow(
        `unsupported option for exec ${value.includes('sessions') ? 'sessions' : 'delete'}: ${option}`,
      )
    }
  })

  it('validates management options before dispatching help or version', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    const cases: Array<[string[], string]> = [
      [argv('exec', 'sessions', '--api-key', 'secret-value', '--help'), '--api-key'],
      [argv('exec', 'sessions', '--yolo', '--version'), '--yolo'],
      [argv('exec', 'delete', id, '--model', 'gpt-5', '--help'), '--model'],
      [argv('exec', 'delete', id, '--yolo', '--version'), '--yolo'],
    ]
    for (const [value, option] of cases) {
      expect(() => parseExecutionArgs(value)).toThrow(
        `unsupported option for exec ${value.includes('sessions') ? 'sessions' : 'delete'}: ${option}`,
      )
    }

    expect(parseExecutionArgs(argv('exec', 'sessions', '--help')).kind).toBe('help')
    expect(parseExecutionArgs(argv('exec', 'delete', id, '--version')).kind).toBe('version')
  })

  it('rejects unknown, unsupported, missing, conflicting and extra args', () => {
    const cases = [
      argv('exec', '--wat', 'hello'),
      argv('exec', '--sandbox', 'read-only', 'hello'),
      argv('exec', '--model'),
      argv('exec', '--model', '--json', 'hello'),
      argv('exec', '--ephemeral=true', 'hello'),
      argv('run', '--no-cleanup=false', 'hello'),
      argv('exec', '--yolo', '--dangerously-bypass-approvals-and-sandbox', 'hello'),
      argv('exec', 'one', 'two'),
      argv('run', '--wat', 'hello'),
      argv('exec', 'review'),
      argv('exec', '--send-timeout', '1000', 'hello'),
      argv('exec', '--stdin', 'hello'),
    ]
    for (const value of cases) {
      expect(() => parseExecutionArgs(value)).toThrow(UsageError)
    }
  })

  it('finds execution commands after value-taking global flags', () => {
    const value = argv('--workspace', 'work', '--provider=openai', 'exec', 'hello')
    expect(findExecutionCommandIndex(value)).toBe(5)
  })

  it('routes run around legacy server options and rejects them as usage errors', () => {
    const before = [
      argv('--url', 'ws://electron.invalid', 'run', 'hello'),
      argv('--token', 'server-secret', 'run', 'hello'),
      argv('--tls-ca', '/tmp/ca.pem', 'run', 'hello'),
      argv('--url=ws://electron.invalid', 'run', 'hello'),
    ]
    for (const value of before) {
      expect(findExecutionCommandIndex(value)).toBeGreaterThanOrEqual(0)
      expect(() => parseExecutionArgs(value)).toThrow(
        /unsupported option for run: --(?:url|token|tls-ca)/,
      )
    }

    const after = [
      argv('run', '--url', 'ws://electron.invalid', 'hello'),
      argv('run', '--token', 'server-secret', 'hello'),
      argv('run', '--tls-ca', '/tmp/ca.pem', 'hello'),
    ]
    for (const value of after) {
      expect(findExecutionCommandIndex(value)).toBe(2)
      expect(() => parseExecutionArgs(value)).toThrow(
        /unsupported option for run: --(?:url|token|tls-ca)/,
      )
    }

    const unsupportedBeforeRun = argv(
      '--sandbox',
      'read-only',
      '--output-schema',
      '/tmp/schema.json',
      'run',
      'hello',
    )
    expect(findExecutionCommandIndex(unsupportedBeforeRun)).toBe(6)
    expect(() => parseExecutionArgs(unsupportedBeforeRun)).toThrow(
      'unsupported option: --sandbox',
    )
  })
})
