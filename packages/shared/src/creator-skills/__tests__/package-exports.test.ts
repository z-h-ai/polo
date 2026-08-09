import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('@polo-ai/shared Creator Skill package exports', () => {
  it('loads validation, DTOs, schemas, and fixtures through declared package exports', () => {
    const repositoryRoot = resolve(import.meta.dir, '../../../../..')
    const require = createRequire(import.meta.url)
    const creatorSkillsPath = require.resolve('@polo-ai/shared/creator-skills', {
      paths: [repositoryRoot],
    })
    const fixturesPath = require.resolve('@polo-ai/shared/creator-skills/fixtures', {
      paths: [repositoryRoot],
    })
    const metadataPath = require.resolve('@polo-ai/shared/creator-skills/metadata', {
      paths: [repositoryRoot],
    })
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
      import { parseCreatorSkillMetadata } from '@polo-ai/shared/creator-skills/metadata'
      if (
        typeof validateCreatorSkillArchive !== 'function'
        || typeof CreatorSkillDownloadGrantSchema?.safeParse !== 'function'
        || !CREATOR_SKILL_FIXTURE_CONTENT.includes('name: review-helper')
        || CREATOR_SKILL_FIXTURE_SLUG !== 'review-helper'
        || CREATOR_SKILL_FIXTURE_METADATA.name !== 'review-helper'
        || parseCreatorSkillMetadata([{ path: 'review-helper/SKILL.md', content: CREATOR_SKILL_FIXTURE_CONTENT }]).slug !== 'review-helper'
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
    expect(metadataPath.endsWith('/dist/creator-skills/metadata.browser.cjs')).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')

    const browserRuntimeScript = `
      globalThis.Buffer = undefined
      globalThis.process = undefined
      globalThis.require = undefined
      const metadata = await import(${JSON.stringify(pathToFileURL(metadataPath).href)})
      const result = metadata.parseCreatorSkillMetadata([{
        path: 'polo-test/SKILL.md',
        content: new TextEncoder().encode('---\\nname: polo-test\\ndescription: Browser proof.\\n---\\n'),
      }])
      if (result.slug !== 'polo-test') process.exitCode = 1
    `
    const browserRuntime = Bun.spawnSync({
      cmd: [process.execPath, '--input-type=module', '--eval', browserRuntimeScript],
      cwd: repositoryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(browserRuntime.exitCode).toBe(0)
    expect(browserRuntime.stderr.toString()).toBe('')
  })
})
