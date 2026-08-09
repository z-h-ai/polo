#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

export interface MacReleaseSigningIdentity {
  teamId: string
  appDesignatedRequirement: string
  uvDesignatedRequirement: string
}

export interface MacReleaseSigningObservation {
  label: string
  appTeamId: string
  appDesignatedRequirement: string
  uvTeamId: string
  uvDesignatedRequirement: string
  appSignature: 'valid' | 'invalid'
  uvSignature: 'valid' | 'invalid'
  notarization: 'accepted' | 'rejected'
  stapling: 'valid' | 'invalid'
}

/** The distributable DMG is a separately signed and stapled release object. */
export interface MacDmgSigningObservation {
  label: string
  dmgTeamId: string
  dmgSignature: 'valid' | 'invalid'
  notarization: 'accepted' | 'rejected'
  stapling: 'valid' | 'invalid'
}

export interface WindowsReleaseSigningIdentity {
  publisher: string
  thumbprint: string
}

export interface WindowsReleaseSigningObservation {
  label: string
  publisher: string
  thumbprint: string
  signature: 'Valid' | string
}

function requireValue(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Release signing contract requires ${name}`)
  return normalized
}

function normalizeThumbprint(value: string): string {
  return value.replaceAll(/\s/g, '').toUpperCase()
}

export function verifyMacReleaseSigningIdentity(
  expected: MacReleaseSigningIdentity,
  actual: MacReleaseSigningObservation,
): Record<string, unknown> {
  const teamId = requireValue(expected.teamId, 'macOS Team ID')
  const appRequirement = requireValue(
    expected.appDesignatedRequirement,
    'macOS App designated requirement',
  )
  const uvRequirement = requireValue(
    expected.uvDesignatedRequirement,
    'macOS uv designated requirement',
  )
  if (actual.appSignature !== 'valid' || actual.uvSignature !== 'valid') {
    throw new Error(`${actual.label} does not have valid App and nested uv signatures`)
  }
  if (!actual.appTeamId || !actual.uvTeamId) {
    throw new Error(`${actual.label} is ad-hoc or has no Team ID`)
  }
  if (actual.appTeamId !== teamId || actual.uvTeamId !== teamId) {
    throw new Error(
      `${actual.label} Team ID mismatch: App=${actual.appTeamId}, uv=${actual.uvTeamId}`,
    )
  }
  if (actual.appDesignatedRequirement !== appRequirement) {
    throw new Error(`${actual.label} App designated requirement mismatch`)
  }
  if (actual.uvDesignatedRequirement !== uvRequirement) {
    throw new Error(`${actual.label} uv designated requirement mismatch`)
  }
  if (actual.notarization !== 'accepted') {
    throw new Error(`${actual.label} did not pass notarization assessment`)
  }
  if (actual.stapling !== 'valid') {
    throw new Error(`${actual.label} does not contain a valid stapled ticket`)
  }
  return {
    schemaVersion: 1,
    platform: 'macos',
    label: actual.label,
    expected: {
      teamId,
      appDesignatedRequirement: appRequirement,
      uvDesignatedRequirement: uvRequirement,
    },
    actual: {
      appTeamId: actual.appTeamId,
      appDesignatedRequirement: actual.appDesignatedRequirement,
      uvTeamId: actual.uvTeamId,
      uvDesignatedRequirement: actual.uvDesignatedRequirement,
      appSignature: actual.appSignature,
      uvSignature: actual.uvSignature,
      notarization: actual.notarization,
      stapling: actual.stapling,
    },
    verified: true,
    verifiedAt: new Date().toISOString(),
  }
}

export function verifyMacDmgSigningIdentity(
  expected: Pick<MacReleaseSigningIdentity, 'teamId'>,
  actual: MacDmgSigningObservation,
): Record<string, unknown> {
  const teamId = requireValue(expected.teamId, 'macOS Team ID')
  if (actual.dmgSignature !== 'valid') {
    throw new Error(`${actual.label} does not have a valid outer DMG signature`)
  }
  if (!actual.dmgTeamId) throw new Error(`${actual.label} is ad-hoc or has no Team ID`)
  if (actual.dmgTeamId !== teamId) {
    throw new Error(`${actual.label} Team ID mismatch: DMG=${actual.dmgTeamId}`)
  }
  if (actual.notarization !== 'accepted') {
    throw new Error(`${actual.label} did not pass notarization assessment`)
  }
  if (actual.stapling !== 'valid') {
    throw new Error(`${actual.label} does not contain a valid stapled ticket`)
  }
  return {
    schemaVersion: 1,
    platform: 'macos',
    artifactKind: 'dmg',
    label: actual.label,
    expected: { teamId },
    actual: {
      dmgTeamId: actual.dmgTeamId,
      dmgSignature: actual.dmgSignature,
      notarization: actual.notarization,
      stapling: actual.stapling,
    },
    verified: true,
    verifiedAt: new Date().toISOString(),
  }
}

export function verifyWindowsReleaseSigningIdentity(
  expected: WindowsReleaseSigningIdentity,
  actual: WindowsReleaseSigningObservation,
): Record<string, unknown> {
  const publisher = requireValue(expected.publisher, 'Windows Publisher')
  const thumbprint = normalizeThumbprint(
    requireValue(expected.thumbprint, 'Windows certificate thumbprint'),
  )
  if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
    throw new Error('Windows release certificate thumbprint must be 40 hexadecimal characters')
  }
  if (actual.signature !== 'Valid') {
    throw new Error(`${actual.label} Authenticode signature is ${actual.signature}`)
  }
  const actualPublisher = requireValue(actual.publisher, `${actual.label} Publisher`)
  const actualThumbprint = normalizeThumbprint(
    requireValue(actual.thumbprint, `${actual.label} certificate thumbprint`),
  )
  if (actualPublisher !== publisher) {
    throw new Error(`${actual.label} Publisher mismatch: ${actualPublisher}`)
  }
  if (actualThumbprint !== thumbprint) {
    throw new Error(`${actual.label} certificate thumbprint mismatch: ${actualThumbprint}`)
  }
  return {
    schemaVersion: 1,
    platform: 'windows',
    label: actual.label,
    expected: { publisher, thumbprint },
    actual: {
      publisher: actualPublisher,
      thumbprint: actualThumbprint,
      signature: actual.signature,
    },
    verified: true,
    verifiedAt: new Date().toISOString(),
  }
}

function appendAudit(path: string | undefined, result: Record<string, unknown>): void {
  const serialized = JSON.stringify(result)
  if (path) appendFileSync(path, `${serialized}\n`, 'utf8')
  process.stdout.write(`release-signing-result ${serialized}\n`)
}

if (import.meta.main) {
  const command = process.argv[2]
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      label: { type: 'string' },
      output: { type: 'string' },
      'expected-team-id': { type: 'string', default: '' },
      'expected-app-requirement': { type: 'string', default: '' },
      'expected-uv-requirement': { type: 'string', default: '' },
      'actual-app-team-id': { type: 'string', default: '' },
      'actual-app-requirement': { type: 'string', default: '' },
      'actual-uv-team-id': { type: 'string', default: '' },
      'actual-uv-requirement': { type: 'string', default: '' },
      'actual-dmg-team-id': { type: 'string', default: '' },
      'app-signature': { type: 'string', default: 'invalid' },
      'uv-signature': { type: 'string', default: 'invalid' },
      'dmg-signature': { type: 'string', default: 'invalid' },
      notarization: { type: 'string', default: 'rejected' },
      stapling: { type: 'string', default: 'invalid' },
      'expected-publisher': { type: 'string', default: '' },
      'expected-thumbprint': { type: 'string', default: '' },
      'actual-publisher': { type: 'string', default: '' },
      'actual-thumbprint': { type: 'string', default: '' },
      signature: { type: 'string', default: 'UnknownError' },
    },
    strict: true,
  })
  const label = requireValue(values.label ?? '', 'artifact label')
  if (command === 'verify-macos') {
    appendAudit(
      values.output,
      verifyMacReleaseSigningIdentity(
        {
          teamId: values['expected-team-id'],
          appDesignatedRequirement: values['expected-app-requirement'],
          uvDesignatedRequirement: values['expected-uv-requirement'],
        },
        {
          label,
          appTeamId: values['actual-app-team-id'],
          appDesignatedRequirement: values['actual-app-requirement'],
          uvTeamId: values['actual-uv-team-id'],
          uvDesignatedRequirement: values['actual-uv-requirement'],
          appSignature: values['app-signature'] as 'valid' | 'invalid',
          uvSignature: values['uv-signature'] as 'valid' | 'invalid',
          notarization: values.notarization as 'accepted' | 'rejected',
          stapling: values.stapling as 'valid' | 'invalid',
        },
      ),
    )
  } else if (command === 'verify-macos-dmg') {
    appendAudit(
      values.output,
      verifyMacDmgSigningIdentity(
        { teamId: values['expected-team-id'] },
        {
          label,
          dmgTeamId: values['actual-dmg-team-id'],
          dmgSignature: values['dmg-signature'] as 'valid' | 'invalid',
          notarization: values.notarization as 'accepted' | 'rejected',
          stapling: values.stapling as 'valid' | 'invalid',
        },
      ),
    )
  } else if (command === 'verify-windows') {
    appendAudit(
      values.output,
      verifyWindowsReleaseSigningIdentity(
        {
          publisher: values['expected-publisher'],
          thumbprint: values['expected-thumbprint'],
        },
        {
          label,
          publisher: values['actual-publisher'],
          thumbprint: values['actual-thumbprint'],
          signature: values.signature,
        },
      ),
    )
  } else {
    throw new Error(`Unknown release signing contract command: ${command ?? '<missing>'}`)
  }
}
