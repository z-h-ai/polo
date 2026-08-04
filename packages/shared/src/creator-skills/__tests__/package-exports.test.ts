import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

describe('@z-h-ai/shared Creator Skill package exports', () => {
  it('loads validation, DTOs, schemas, and fixtures through declared package exports', () => {
    const repositoryRoot = resolve(import.meta.dir, '../../../../..')
    const require = createRequire(import.meta.url)
    const creatorSkillsPath = require.resolve('@z-h-ai/shared/creator-skills', {
      paths: [repositoryRoot],
    })
    const fixturesPath = require.resolve('@z-h-ai/shared/creator-skills/fixtures', {
      paths: [repositoryRoot],
    })
    const script = `
      import {
        CreatorSkillDownloadGrantSchema,
        CREATOR_SKILL_FIXTURE_CONTENT,
        CREATOR_SKILL_FIXTURE_SLUG,
        validateCreatorSkillArchive,
      } from '@z-h-ai/shared/creator-skills'
      import {
        CREATOR_SKILL_FIXTURE_METADATA,
      } from '@z-h-ai/shared/creator-skills/fixtures'
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

    expect(creatorSkillsPath.endsWith('/dist/creator-skills/index.cjs')).toBe(true)
    expect(fixturesPath.endsWith('/dist/creator-skills/fixtures.cjs')).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
  })
})
