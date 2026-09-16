export type ColorMode = 'always' | 'never' | 'auto'

// Covers CSI and the common single-character ANSI escape forms without
// depending on a terminal formatting package in the CLI protocol path.
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

export function colorModeFromArgv(argv: string[]): ColorMode {
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index]
    if (token?.startsWith('--color=')) {
      const value = token.slice('--color='.length)
      if (value === 'always' || value === 'never' || value === 'auto') return value
    }
    if (token === '--color') {
      const value = argv[index + 1]
      if (value === 'always' || value === 'never' || value === 'auto') return value
    }
  }
  return 'auto'
}

export function shouldColorStderr(
  mode: ColorMode,
  stderrIsTty = process.stderr.isTTY === true,
): boolean {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return stderrIsTty && !process.env.NO_COLOR
}

export function stderrErrorLine(message: string, mode: ColorMode): string {
  const clean = stripAnsi(message)
  const label = shouldColorStderr(mode) ? '\u001B[31mError:\u001B[39m' : 'Error:'
  return `${label} ${clean}\n`
}

export function stderrLabel(label: string, mode: ColorMode): string {
  const clean = stripAnsi(label)
  return shouldColorStderr(mode) ? `\u001B[36m${clean}\u001B[39m` : clean
}
