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
})
