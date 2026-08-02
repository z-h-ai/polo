import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import {
  creatorSkillErrorDiagnostic,
  translateCreatorSkillError,
} from '../creator-skill-errors'

beforeAll(async () => {
  setupI18n()
  await i18n.changeLanguage('es')
})

afterAll(async () => {
  await i18n.changeLanguage('en')
})

describe('Creator Skill renderer error translation', () => {
  it('uses the localized stable code and never the backend English message', () => {
    const translated = translateCreatorSkillError(i18n.t, {
      errorCode: 'workspace_read_only',
      message: 'Workspace is read-only',
    })

    expect(translated).toContain('solo lectura')
    expect(translated).not.toContain('Workspace is read-only')
  })

  it('uses the localized unknown error without exposing backend text', () => {
    const payload = {
      errorCode: 'future_backend_code',
      message: 'A future backend English failure',
    }
    const translated = translateCreatorSkillError(i18n.t, payload)

    expect(translated).toBe(i18n.t('creatorSkills.errors.unknown'))
    expect(translated).not.toContain(payload.message)
    expect(creatorSkillErrorDiagnostic(payload)).toBe(
      JSON.stringify({ errorCode: payload.errorCode }),
    )
  })

  it('strips Node system paths and messages from copyable diagnostics', () => {
    const workspacePath = '/private/workspace/skills/review-helper'
    const diagnostic = creatorSkillErrorDiagnostic({
      errorCode: 'creator_skill_install_failed',
      diagnostic: JSON.stringify({
        operationId: '11111111-1111-4111-8111-111111111111',
        stage: 'commit',
        errorCode: 'creator_skill_install_failed',
        path: workspacePath,
        message: `EACCES: rename '${workspacePath}'`,
        dest: '/private/workspace/.creator-skill-ops/stage',
      }),
    })

    expect(diagnostic).toBe(JSON.stringify({
      operationId: '11111111-1111-4111-8111-111111111111',
      stage: 'commit',
      errorCode: 'creator_skill_install_failed',
    }))
    expect(diagnostic).not.toContain('/private')
    expect(diagnostic).not.toContain('EACCES')
  })
})
