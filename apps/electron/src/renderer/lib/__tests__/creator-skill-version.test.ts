import { describe, expect, it } from 'bun:test'
import { actionableCreatorSkillSafeVersion } from '../creator-skill-version'

describe('actionableCreatorSkillSafeVersion', () => {
  it('offers a lower safe version when the installed version is revoked', () => {
    expect(actionableCreatorSkillSafeVersion({
      candidate: '1.4.0',
      installedVersion: '2.0.0',
      status: 'revoked',
    })).toBe('1.4.0')
  })

  it('does not offer a normal downgrade for an active installation', () => {
    expect(actionableCreatorSkillSafeVersion({
      candidate: '1.4.0',
      installedVersion: '2.0.0',
      status: 'active',
    })).toBeNull()
  })

  it('still offers higher safe updates and honors ignored versions', () => {
    expect(actionableCreatorSkillSafeVersion({
      candidate: '2.1.0',
      installedVersion: '2.0.0',
      status: 'active',
    })).toBe('2.1.0')
    expect(actionableCreatorSkillSafeVersion({
      candidate: '2.1.0',
      installedVersion: '2.0.0',
      ignoredVersion: '2.1.0',
      status: 'active',
    })).toBeNull()
  })
})
