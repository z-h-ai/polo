import { describe, expect, it } from 'bun:test'
import { validateSkillContent } from '../../config/validators'
import {
  validateCreatorSkillContent,
  validatePortableSkillContent,
} from '../skill-content'

const CONTENT = `---
name: Legacy Slug
description: Keeps the historical local Skill slug contract.
---

Follow the instructions.
`

describe('local and Creator Skill slug policies', () => {
  it('preserves the historical local Skill slug baseline and error semantics', () => {
    for (const slug of ['foo--bar', '-foo', 'foo-']) {
      expect(validatePortableSkillContent(CONTENT, slug).valid).toBe(true)
      expect(validateSkillContent(CONTENT, slug).valid).toBe(true)
    }
    const invalid = validateSkillContent(CONTENT, 'Foo')
    expect(invalid).toMatchObject({
      valid: false,
      errors: [{
        path: 'slug',
        message: 'Slug must be lowercase alphanumeric with hyphens',
      }],
    })
  })

  it('layers strict kebab-case only onto Creator Skill publication', () => {
    const creatorContent = CONTENT.replace('name: Legacy Slug', 'name: foo-bar')
    expect(validateCreatorSkillContent(creatorContent, 'foo-bar').valid).toBe(true)
    for (const slug of ['foo--bar', '-foo', 'foo-']) {
      const validation = validateCreatorSkillContent(creatorContent, slug)
      expect(validation.valid).toBe(false)
      expect(validation.errors).toContainEqual(expect.objectContaining({
        path: 'slug',
        message: 'Creator Skill slug must use strict kebab-case',
      }))
    }
  })

  it('requires a strict metadata name matching the Creator Skill root', () => {
    expect(validateCreatorSkillContent(CONTENT, 'foo-bar')).toMatchObject({
      valid: false,
      errors: [{ path: 'name', message: expect.stringContaining('strict kebab-case') }],
    })
    expect(validateCreatorSkillContent(
      CONTENT.replace('name: Legacy Slug', 'name: another-skill'),
      'foo-bar',
    )).toMatchObject({
      valid: false,
      errors: [{ path: 'name', message: expect.stringContaining("must match root directory 'foo-bar'") }],
    })
  })

  it('uses the shared YAML parser and empty-body issue for Creator content validation', () => {
    const yamlContent = `---
name: foo-bar # inline comment
description: >-
  Supports folded descriptions
  and nested metadata.
metadata:
  owner:
    team: Creator
---

Do the work.
`
    expect(validateCreatorSkillContent(yamlContent, 'foo-bar')).toMatchObject({ valid: true })
    expect(validateCreatorSkillContent(`---
name: foo-bar
description: 42
---

Do the work.
`, 'foo-bar')).toMatchObject({
      valid: false,
      errors: [{
        code: 'invalid_skill_content',
        path: 'description',
        message: 'Creator Skill description is required and must be a string',
      }],
    })
    expect(validateCreatorSkillContent(`---
name: foo-bar
description: Valid.
---
`, 'foo-bar')).toMatchObject({
      valid: false,
      errors: [{
        code: 'invalid_skill_content',
        path: 'content',
        message: 'Skill content is empty (nothing after frontmatter)',
        suggestion: 'Add instructions after the frontmatter describing what the skill should do',
      }],
    })
    for (const icon of ['https://example.test/icon.png', './icon.png', 'Review 🧭']) {
      expect(validateCreatorSkillContent(`---
name: foo-bar
description: Valid.
icon: ${JSON.stringify(icon)}
---

Do the work.
`, 'foo-bar')).toMatchObject({
        valid: false,
        errors: [{
          code: 'invalid_skill_content',
          path: 'icon',
          message: 'Creator Skill frontmatter icon must be an emoji, not a URL, file path, or decorative text',
        }],
      })
    }
    expect(validateCreatorSkillContent(`---
name: foo-bar
description: test
value: *missing
---

Do the work.
`, 'foo-bar')).toMatchObject({
      valid: false,
      errors: [{
        code: 'invalid_skill_content',
        path: 'frontmatter',
        message: 'SKILL.md frontmatter must contain valid YAML metadata',
      }],
    })
  })
})
