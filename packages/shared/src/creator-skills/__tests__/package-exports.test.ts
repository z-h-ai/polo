import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

describe('@polo-ai/shared Creator Skill package exports', () => {
  it('loads validation, DTOs, schemas, and fixtures through declared package exports', () => {
    const repositoryRoot = resolve(import.meta.dir, '../../../../..')
    const script = `
      import {
        CreatorSkillDownloadGrantSchema,
        CREATOR_SKILL_FIXTURE_CONTENT,
        CREATOR_SKILL_FIXTURE_SLUG,
        validateCreatorSkillArchive,
      } from '@polo-ai/shared/creator-skills'
      import {
        CREATOR_SKILL_FIXTURE_METADATA,
      } from '@polo-ai/shared/creator-skills/fixtures'
      if (
        typeof validateCreatorSkillArchive !== 'function'
        || typeof CreatorSkillDownloadGrantSchema?.safeParse !== 'function'
        || !CREATOR_SKILL_FIXTURE_CONTENT.includes('Review Helper')
        || CREATOR_SKILL_FIXTURE_SLUG !== 'review-helper'
        || CREATOR_SKILL_FIXTURE_METADATA.name !== 'Review Helper'
      ) process.exit(1)
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: repositoryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
  })
})
