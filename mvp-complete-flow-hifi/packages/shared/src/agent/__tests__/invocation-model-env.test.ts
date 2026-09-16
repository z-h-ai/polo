import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClaudeSubprocessEnv,
  getDefaultOptions,
  resetClaudeConfigCheck,
} from '../options.ts'
import { buildPiSubprocessEnvironment } from '../pi-agent.ts'

const tempDirs: string[] = []
const originalUnknownSecret = process.env.COMPANY_SSO_REFRESH_MATERIAL
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE

afterEach(() => {
  if (originalUnknownSecret === undefined) {
    delete process.env.COMPANY_SSO_REFRESH_MATERIAL
  } else {
    process.env.COMPANY_SSO_REFRESH_MATERIAL = originalUnknownSecret
  }
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  resetClaudeConfigCheck()
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('invocation-scoped model subprocess environment', () => {
  it('uses a private Claude home without modifying the shared home', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-claude-private-home-'))
    tempDirs.push(temp)
    const sharedHome = join(temp, 'shared-home')
    const privateHome = join(temp, 'thread', 'meta', 'claude-home')
    mkdirSync(sharedHome)
    writeFileSync(join(sharedHome, '.claude.json'), '{shared-corrupt')
    writeFileSync(join(sharedHome, '.claude.json.backup'), 'shared-backup')
    process.env.HOME = sharedHome
    process.env.USERPROFILE = sharedHome
    process.env.COMPANY_SSO_REFRESH_MATERIAL = 'unknown-real-oauth-secret'

    const options = getDefaultOptions({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:45123',
      ANTHROPIC_API_KEY: 'opaque-local-capability',
      COMPANY_SSO_REFRESH_MATERIAL: 'config-secret-must-not-pass',
    }, {
      credentialIsolation: true,
      privateHome,
    })

    expect(readFileSync(join(sharedHome, '.claude.json'), 'utf-8')).toBe('{shared-corrupt')
    expect(readFileSync(join(sharedHome, '.claude.json.backup'), 'utf-8')).toBe('shared-backup')
    expect(readFileSync(join(privateHome, '.claude.json'), 'utf-8')).toBe('{}')
    expect(options.env?.HOME).toBe(privateHome)
    expect(options.env?.ANTHROPIC_API_KEY).toBe('opaque-local-capability')
    expect(options.env?.COMPANY_SSO_REFRESH_MATERIAL).toBeUndefined()
    if (process.platform !== 'win32') {
      expect(statSync(privateHome).mode & 0o777).toBe(0o700)
      expect(statSync(join(privateHome, '.claude.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('omits unknown parent and config secrets from both CLI model runtimes', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-model-env-'))
    tempDirs.push(temp)
    process.env.COMPANY_SSO_REFRESH_MATERIAL = 'unknown-real-oauth-secret'

    const claudeEnv = buildClaudeSubprocessEnv({
      ANTHROPIC_API_KEY: 'opaque-local-capability',
      COMPANY_SSO_REFRESH_MATERIAL: 'config-secret-must-not-pass',
    }, {
      credentialIsolation: true,
      privateHome: join(temp, 'claude-home'),
    })
    const piEnv = buildPiSubprocessEnvironment({
      invocationScoped: true,
      privateHome: join(temp, 'pi-home'),
      envOverrides: {
        COMPANY_SSO_REFRESH_MATERIAL: 'config-secret-must-not-pass',
      },
      sessionDir: join(temp, 'session'),
    })

    expect(claudeEnv.COMPANY_SSO_REFRESH_MATERIAL).toBeUndefined()
    expect(piEnv.COMPANY_SSO_REFRESH_MATERIAL).toBeUndefined()
    expect(piEnv.POLO_AI_SESSION_DIR).toBe(join(temp, 'session'))
  })

  it('preserves Electron Pi custom environment behavior', () => {
    process.env.COMPANY_SSO_REFRESH_MATERIAL = 'desktop-parent-value'
    const env = buildPiSubprocessEnvironment({
      invocationScoped: false,
      envOverrides: {
        COMPANY_SSO_REFRESH_MATERIAL: 'desktop-custom-value',
        CUSTOM_TOOL_SETTING: 'enabled',
      },
      awsEnv: { AWS_REGION: 'us-west-2' },
    })

    expect(env.COMPANY_SSO_REFRESH_MATERIAL).toBe('desktop-custom-value')
    expect(env.CUSTOM_TOOL_SETTING).toBe('enabled')
    expect(env.AWS_REGION).toBe('us-west-2')
  })
})
