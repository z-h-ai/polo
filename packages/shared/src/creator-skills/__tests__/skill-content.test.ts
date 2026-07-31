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
    expect(validateCreatorSkillContent(CONTENT, 'foo-bar').valid).toBe(true)
    for (const slug of ['foo--bar', '-foo', 'foo-']) {
      expect(validateCreatorSkillContent(CONTENT, slug)).toMatchObject({
        valid: false,
        errors: [{
          path: 'slug',
          message: 'Creator Skill slug must use strict kebab-case',
        }],
      })
    }
  })
})
