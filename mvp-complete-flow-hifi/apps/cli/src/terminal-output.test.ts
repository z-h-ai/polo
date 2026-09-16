import { describe, expect, it } from 'bun:test'
import {
  shouldColorStderr,
  stderrErrorLine,
  stripAnsi,
} from './terminal-output.ts'

describe('one-shot terminal output', () => {
  it('strips ANSI from protocol stdout content', () => {
    expect(stripAnsi('\u001B[31manswer\u001B[39m')).toBe('answer')
  })

  it('applies --color only to stderr decoration', () => {
    expect(shouldColorStderr('always', false)).toBe(true)
    expect(shouldColorStderr('never', true)).toBe(false)
    expect(stderrErrorLine('boom', 'always')).toContain('\u001B[31m')
    expect(stderrErrorLine('\u001B[32mboom\u001B[39m', 'never')).toBe('Error: boom\n')
  })
})
