import { describe, expect, it } from 'bun:test'
import {
  CreatorSkillMetadataError,
  parseCreatorSkillMetadata,
} from '../metadata'

const skill = `---
name: polo-test
description: Verifies a Creator Skill package.
---

Use this Skill.
`

describe('browser-safe Creator Skill metadata parser', () => {
  it('returns the strict name as slug from normalized ZIP entries', () => {
    const result = parseCreatorSkillMetadata([
      { path: 'polo-test/SKILL.md', content: new TextEncoder().encode(skill) },
      { path: 'polo-test/agents/reviewer.md', content: 'Review.' },
      { path: 'polo-test/custom/data.json', content: '{}' },
    ])
    expect(result).toMatchObject({
      slug: 'polo-test',
      metadata: {
        name: 'polo-test',
        description: 'Verifies a Creator Skill package.',
      },
    })
  })

  it('shares the root and metadata failures used by archive validation', () => {
    expect(() => parseCreatorSkillMetadata([
      { path: 'polo-test/SKILL.md', content: skill.replace('name: polo-test', 'name: Polo Test') },
    ])).toThrow(CreatorSkillMetadataError)

    expect(() => parseCreatorSkillMetadata([
      { path: 'polo-test/SKILL.md', content: skill },
      { path: 'other/SKILL.md', content: skill },
    ])).toThrow(CreatorSkillMetadataError)
  })

  it('ignores the same packaging noise as the server archive validator', () => {
    const result = parseCreatorSkillMetadata([
      { path: '__MACOSX/._SKILL.md', content: 'noise' },
      { path: 'polo-test/.DS_Store', content: 'noise' },
      { path: 'polo-test/Thumbs.db', content: 'noise' },
      { path: 'polo-test/desktop.ini', content: 'noise' },
      { path: 'polo-test/._resource', content: 'noise' },
      { path: 'polo-test/SKILL.md', content: skill },
    ])
    expect(result.slug).toBe('polo-test')
  })

  it('rejects invalid UTF-8 with a structured portable issue', () => {
    try {
      parseCreatorSkillMetadata([
        { path: 'polo-test/SKILL.md', content: new Uint8Array([0xff, 0xfe]) },
      ])
      throw new Error('expected invalid UTF-8 to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(CreatorSkillMetadataError)
      expect((error as CreatorSkillMetadataError).issues).toEqual([{
        code: 'invalid_skill_utf8',
        path: 'polo-test/SKILL.md',
        message: 'SKILL.md must contain valid UTF-8 text',
      }])
    }
  })
})
