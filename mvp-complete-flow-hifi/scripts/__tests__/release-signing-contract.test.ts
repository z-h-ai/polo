import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyMacDmgReleaseIntegrity,
  verifyMacReleaseSigningIdentity,
  verifyWindowsReleaseSigningIdentity,
} from '../release-signing-contract'

const macExpected = {
  teamId: 'ABCDE12345',
  appDesignatedRequirement:
    'identifier "com.poloai.app" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
  uvDesignatedRequirement:
    'identifier "uv" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
}
const macActual = {
  label: 'fixture App',
  appTeamId: 'ABCDE12345',
  appDesignatedRequirement: macExpected.appDesignatedRequirement,
  uvTeamId: 'ABCDE12345',
  uvDesignatedRequirement: macExpected.uvDesignatedRequirement,
  appSignature: 'valid' as const,
  uvSignature: 'valid' as const,
  notarization: 'accepted' as const,
  stapling: 'valid' as const,
}
const macDmgActual = {
  label: 'fixture DMG outer',
  notarization: 'accepted' as const,
  stapling: 'valid' as const,
}
const windowsExpected = {
  publisher: 'CN=Polo AI, O=Polo AI Inc., C=US',
  thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567',
}
const windowsActual = {
  label: 'fixture.exe',
  publisher: windowsExpected.publisher,
  thumbprint: windowsExpected.thumbprint,
  signature: 'Valid',
}

describe('release signing identity contract', () => {
  it('rejects a missing release identity instead of silently accepting smoke identity', () => {
    expect(() => verifyMacReleaseSigningIdentity(
      { ...macExpected, teamId: '' },
      macActual,
    )).toThrow('requires macOS Team ID')
    expect(() => verifyWindowsReleaseSigningIdentity(
      { ...windowsExpected, publisher: '' },
      windowsActual,
    )).toThrow('requires Windows Publisher')
  })

  it('rejects ad-hoc macOS signatures without a Team ID', () => {
    expect(() => verifyMacReleaseSigningIdentity(macExpected, {
      ...macActual,
      appTeamId: '',
      uvTeamId: '',
    })).toThrow('ad-hoc or has no Team ID')
  })

  it('rejects wrong macOS Team IDs, requirements, notarization, and stapling', () => {
    expect(() => verifyMacReleaseSigningIdentity(macExpected, {
      ...macActual,
      uvTeamId: 'WRONG12345',
    })).toThrow('Team ID mismatch')
    expect(() => verifyMacReleaseSigningIdentity(macExpected, {
      ...macActual,
      appDesignatedRequirement: 'identifier "other"',
    })).toThrow('App designated requirement mismatch')
    expect(() => verifyMacReleaseSigningIdentity(macExpected, {
      ...macActual,
      notarization: 'rejected',
    })).toThrow('notarization assessment')
    expect(() => verifyMacReleaseSigningIdentity(macExpected, {
      ...macActual,
      stapling: 'invalid',
    })).toThrow('stapled ticket')
  })

  it('accepts and audits the exact macOS production identity', () => {
    expect(verifyMacReleaseSigningIdentity(macExpected, macActual)).toMatchObject({
      platform: 'macos',
      expected: macExpected,
      verified: true,
    })
  })

  it('requires a separately notarized and stapled outer DMG release object', () => {
    expect(() => verifyMacDmgReleaseIntegrity({
      ...macDmgActual,
      notarization: 'rejected',
    })).toThrow('notarization assessment')
    expect(() => verifyMacDmgReleaseIntegrity({
      ...macDmgActual,
      stapling: 'invalid',
    })).toThrow('stapled ticket')
    expect(verifyMacDmgReleaseIntegrity(macDmgActual)).toMatchObject({
      artifactKind: 'dmg',
      expected: {
        signingIdentity: 'verified-after-mount',
      },
      verified: true,
    })
  })

  it('rejects wrong Windows Publisher, thumbprint, and signature status', () => {
    expect(() => verifyWindowsReleaseSigningIdentity(windowsExpected, {
      ...windowsActual,
      publisher: 'CN=Other Publisher',
    })).toThrow('Publisher mismatch')
    expect(() => verifyWindowsReleaseSigningIdentity(windowsExpected, {
      ...windowsActual,
      thumbprint: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    })).toThrow('thumbprint mismatch')
    expect(() => verifyWindowsReleaseSigningIdentity(windowsExpected, {
      ...windowsActual,
      signature: 'NotSigned',
    })).toThrow('signature is NotSigned')
  })

  it('accepts and audits the exact Windows production identity', () => {
    expect(verifyWindowsReleaseSigningIdentity(
      windowsExpected,
      { ...windowsActual, thumbprint: windowsActual.thumbprint.toLowerCase() },
    )).toMatchObject({
      platform: 'windows',
      expected: windowsExpected,
      verified: true,
    })
  })

  it('writes an auditable JSONL record from the validator CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'polo signing audit '))
    const audit = join(root, 'audit.jsonl')
    try {
      const result = Bun.spawnSync([
        process.execPath,
        'run',
        join(import.meta.dir, '..', 'release-signing-contract.ts'),
        'verify-windows',
        '--label',
        windowsActual.label,
        '--expected-publisher',
        windowsExpected.publisher,
        '--expected-thumbprint',
        windowsExpected.thumbprint,
        '--actual-publisher',
        windowsActual.publisher,
        '--actual-thumbprint',
        windowsActual.thumbprint,
        '--signature',
        windowsActual.signature,
        '--output',
        audit,
      ], { stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(readFileSync(audit, 'utf8').trim())).toMatchObject({
        platform: 'windows',
        label: windowsActual.label,
        verified: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
