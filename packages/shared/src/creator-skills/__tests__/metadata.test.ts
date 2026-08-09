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

function issueFor(entries: Parameters<typeof parseCreatorSkillMetadata>[0]) {
  try {
    parseCreatorSkillMetadata(entries)
    throw new Error('expected metadata parsing to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(CreatorSkillMetadataError)
    return (error as CreatorSkillMetadataError).issues[0]!
  }
}

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

  it('accepts folded YAML, nested metadata, and inline comments', () => {
    const result = parseCreatorSkillMetadata([{
      path: 'polo-test/SKILL.md',
      content: `--- # frontmatter
name: polo-test # stable package slug
description: >-
  Reviews complex changes
  while preserving intent.
metadata:
  maintainer:
    team: Creator Platform
  capabilities: [review, validation] # nested metadata is allowed
globs: [src/**/*.ts, "docs/**"] # inline comment
alwaysAllow:
  - read
requiredSources: [github]
---

Follow the repository conventions.
`,
    }])
    expect(result).toMatchObject({
      slug: 'polo-test',
      metadata: {
        name: 'polo-test',
        description: 'Reviews complex changes while preserving intent.',
        globs: ['src/**/*.ts', 'docs/**'],
        alwaysAllow: ['read'],
        requiredSources: ['github'],
      },
    })
    expect(issueFor([{
      path: 'polo-test/SKILL.md',
      content: skill.replace('description: Verifies a Creator Skill package.', 'description: 42'),
    }])).toMatchObject({
      code: 'invalid_skill_content',
      path: 'polo-test/SKILL.md',
      field: 'description',
      message: 'Creator Skill description is required and must be a string',
    })
  })

  it('uses one canonical SKILL.md failure for every invalid candidate layout', () => {
    const expected = {
      code: 'skill_file_count',
      path: 'polo-test/SKILL.md',
      message: 'Exactly one SKILL.md basename is allowed and it must be at the package root',
    } as const
    for (const entries of [
      [{ path: 'polo-test/README.md', content: 'No entrypoint.' }],
      [{ path: 'polo-test/agents/SKILL.md', content: skill }],
      [{ path: 'polo-test/skill.MD', content: skill }],
      [
        { path: 'polo-test/SKILL.md', content: skill },
        { path: 'polo-test/agents/SKILL.md', content: skill },
      ],
    ]) {
      expect(issueFor(entries)).toEqual(expected)
    }
  })

  it('rejects an empty body through the shared content issue', () => {
    expect(issueFor([{
      path: 'polo-test/SKILL.md',
      content: `---
name: polo-test
description: Verifies a Creator Skill package.
---
`,
    }])).toEqual({
      code: 'invalid_skill_content',
      path: 'polo-test/SKILL.md',
      field: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    })
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
