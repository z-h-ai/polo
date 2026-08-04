import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@z-h-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()

mock.module('@polo-ai/ui', () => ({
  Spinner: () => createElement('span', { 'data-testid': 'spinner' }),
}))

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} = await import('@testing-library/react')
const { CreatorArtifactsPanel } = await import('../CreatorArtifactsPanel')

const organizationId = 'organization-one'
const commonArtifact = {
  organizationId,
  status: 'published' as const,
  createdByUserId: 'user-one',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
}
const webApp = {
  ...commonArtifact,
  id: 'web-app-one',
  type: 'web_app' as const,
  slug: 'Legacy_App',
  name: 'Legacy Dashboard',
}
const skill = {
  ...commonArtifact,
  id: 'skill-one',
  type: 'skill' as const,
  slug: 'review-skill',
  name: 'Review Skill',
  latestPublishedVersion: '1.0.0',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let listInput: unknown
let listInputs: Array<Record<string, unknown>>
let artifactListResponse: (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>
let detailVersions: Array<Record<string, unknown>>
let detailArtifact: typeof skill
let detailInputs: Array<Record<string, unknown>>
let detailResponse: (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>
let installResponse: (
  input: { operationId: string },
) => Promise<Record<string, unknown>> | Record<string, unknown>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  listInput = undefined
  listInputs = []
  artifactListResponse = () => ({
    success: true as const,
    artifacts: [webApp, skill],
  })
  detailVersions = []
  detailArtifact = skill
  detailInputs = []
  detailResponse = () => ({
    success: true as const,
    artifact: detailArtifact,
    versions: detailVersions,
  })
  installResponse = input => ({
    success: false as const,
    operationId: input.operationId,
    errorCode: 'workspace_read_only',
    stage: 'prepare' as const,
    diagnostic: JSON.stringify({
      errorCode: 'workspace_read_only',
      stage: 'prepare',
    }),
    retryable: false,
  })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      creatorArtifactGetCapabilities: async () => ({
        success: true as const,
        creatorSkillArtifacts: true,
      }),
      creatorArtifactList: async (input: unknown) => {
        listInput = input
        listInputs.push(input as Record<string, unknown>)
        return artifactListResponse(input as Record<string, unknown>)
      },
      creatorArtifactGet: async (input: Record<string, unknown>) => {
        detailInputs.push(input)
        return detailResponse(input)
      },
      creatorSkillGetTarget: async () => ({
        success: true as const,
        workspaceId: 'workspace-one',
        name: 'Workspace One',
        path: '/workspace-one',
        writable: true,
      }),
      creatorSkillGetDownloadGrant: async () => ({
        success: true as const,
        artifactId: skill.id,
        organizationId,
        slug: skill.slug,
        version: '1.0.0',
        url: 'https://download.example.test/review-skill.zip',
        expiresAt: '2030-01-01T00:00:00.000Z',
        archiveChecksum: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        manifest: [],
        validationPolicy: {
          version: '1',
          maxArchiveBytes: 20 * 1024 * 1024,
          maxFileCount: 200,
          maxFileBytes: 5 * 1024 * 1024,
          maxExpandedBytes: 50 * 1024 * 1024,
        },
      }),
      creatorSkillInstall: async (input: { operationId: string }) => (
        installResponse(input)
      ),
      onCreatorSkillProgress: () => () => {},
      creatorSkillCancel: async () => ({ success: true as const }),
      openUrl: async () => {},
    },
  })
})

afterEach(() => {
  cleanup()
})

function panelTree(
  canManage: boolean,
  workspaceId: string | null = null,
  panelOrganizationId = organizationId,
) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(CreatorArtifactsPanel, {
      organizationId: panelOrganizationId,
      canManage,
      workspaceId,
      sessionId: workspaceId ? 'session-one' : null,
    }),
  )
}

function renderPanel(
  canManage: boolean,
  workspaceId: string | null = null,
  panelOrganizationId = organizationId,
) {
  return render(panelTree(canManage, workspaceId, panelOrganizationId))
}

describe('CreatorArtifactsPanel', () => {
  it('polls validation details single-flight after each delayed response settles', async () => {
    const initialDetail = deferred<Record<string, unknown>>()
    const slowPoll = deferred<Record<string, unknown>>()
    let requestCount = 0
    const validatingVersion = {
      id: 'version-draft',
      artifactId: skill.id,
      version: '2.0.0',
      status: 'validating' as const,
      uploadGeneration: 1,
      createdAt: '2026-07-30T00:00:00.000Z',
    }
    detailArtifact = {
      ...skill,
      latestPublishedVersion: '',
    }
    detailVersions = [validatingVersion]
    detailResponse = () => {
      requestCount += 1
      if (requestCount === 1) return initialDetail.promise
      if (requestCount === 2) return slowPoll.promise
      return {
        success: true as const,
        artifact: detailArtifact,
        versions: requestCount >= 3
          ? [{ ...validatingVersion, status: 'validated' as const }]
          : [validatingVersion],
      }
    }

    renderPanel(true, 'workspace-one')
    fireEvent.click(await screen.findByText('Review Skill'))
    await waitFor(() => expect(requestCount).toBe(1))

    const scheduled: Array<() => void> = []
    const originalSetTimeout = window.setTimeout
    const originalClearTimeout = window.clearTimeout
    window.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler !== 'function') throw new Error('Unexpected string timer')
      scheduled.push(handler as () => void)
      return scheduled.length
    }) as typeof window.setTimeout
    window.clearTimeout = (() => {}) as typeof window.clearTimeout
    try {
      await act(async () => {
        initialDetail.resolve({
          success: true as const,
          artifact: detailArtifact,
          versions: [validatingVersion],
        })
        await initialDetail.promise
        for (let index = 0; index < 4; index += 1) await Promise.resolve()
      })
      expect(scheduled).toHaveLength(1)

      await act(async () => {
        scheduled.shift()?.()
        await Promise.resolve()
      })
      expect(requestCount).toBe(2)
      expect(scheduled).toHaveLength(0)

      // A response slower than any nominal interval cannot create another
      // request because no successor timer exists until this one settles.
      await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
      })
      expect(requestCount).toBe(2)

      await act(async () => {
        slowPoll.resolve({
          success: true as const,
          artifact: detailArtifact,
          versions: [validatingVersion],
        })
        await slowPoll.promise
        for (let index = 0; index < 4; index += 1) await Promise.resolve()
      })
      expect(scheduled).toHaveLength(1)

      await act(async () => {
        scheduled.shift()?.()
        for (let index = 0; index < 4; index += 1) await Promise.resolve()
      })
      expect(requestCount).toBe(3)
    } finally {
      window.setTimeout = originalSetTimeout
      window.clearTimeout = originalClearTimeout
    }
  })

  it('requests an aggregate catalog and renders Web App and Skill type badges', async () => {
    renderPanel(false)

    expect(await screen.findAllByText('Legacy Dashboard')).toHaveLength(2)
    expect(await screen.findByText('Review Skill')).toBeTruthy()
    expect(listInput).toEqual({
      organizationId,
      includeDrafts: false,
    })
    const rows = screen.getAllByTestId('creator-artifact-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Web App')
    expect(rows[1]!.textContent).toContain('Skill')
  })

  it('loads every catalog page with the same filters and deduplicates artifacts', async () => {
    const secondSkill = {
      ...skill,
      id: 'skill-two',
      slug: 'second-skill',
      name: 'Second Skill',
    }
    artifactListResponse = input => input.cursor
      ? {
          success: true as const,
          artifacts: [skill, secondSkill],
        }
      : {
          success: true as const,
          artifacts: [webApp, skill],
          nextCursor: 'page-two',
        }

    renderPanel(true)
    expect(await screen.findByText('Review Skill')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more works' }))
    expect(await screen.findByText('Second Skill')).toBeTruthy()
    expect(screen.getAllByTestId('creator-artifact-row')).toHaveLength(3)
    expect(listInputs).toEqual([
      { organizationId, includeDrafts: true },
      { organizationId, includeDrafts: true, cursor: 'page-two' },
    ])
  })

  it('uses the localized initial changelog for the first Skill version', async () => {
    renderPanel(true)
    const skillRow = await screen.findByText('Review Skill')
    fireEvent.click(skillRow.closest('button')!)

    await waitFor(() => {
      const input = document.querySelector('#creator-skill-changelog') as HTMLInputElement | null
      expect(input?.value).toBe('Initial release')
    })
  })

  it('renders the initial changelog in the active non-English locale', async () => {
    await i18n.changeLanguage('es')
    renderPanel(true)
    const skillRow = await screen.findByText('Review Skill')
    fireEvent.click(skillRow.closest('button')!)

    await waitFor(() => {
      const input = document.querySelector('#creator-skill-changelog') as HTMLInputElement | null
      expect(input?.value).toBe('Lanzamiento inicial')
    })
  })

  it('renders the Skill slug placeholder through the active locale', async () => {
    await i18n.changeLanguage('es')
    renderPanel(true)
    const typeSelect = await screen.findByTestId('creator-artifact-type-select')
    fireEvent.pointerDown(typeSelect, {
      button: 0,
      buttons: 1,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    fireEvent.click(await screen.findByRole('option', { name: 'Skill' }))

    expect((document.querySelector('#creator-skill-slug') as HTMLInputElement).placeholder)
      .toBe('mi-skill')
  })

  it('localizes workspace mutation errors without a server message', async () => {
    detailVersions = [{
      id: 'version-one',
      artifactId: skill.id,
      version: '1.0.0',
      status: 'published',
      createdAt: '2026-07-30T00:00:00.000Z',
      publishedAt: '2026-07-30T00:00:00.000Z',
      uploadGeneration: 1,
    }]
    renderPanel(false, 'workspace-one')
    const skillRow = await screen.findByText('Review Skill')
    fireEvent.click(skillRow.closest('button')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('This workspace is read-only. Skill changes are not allowed.')
    expect(i18n.t('creatorSkills.errors.workspace_context_mismatch'))
      .toBe('This workspace is no longer the active workspace. Reopen it and try again.')
  })

  it('shows current and incoming source/version for a different artifact conflict', async () => {
    detailVersions = [{
      id: 'version-one',
      artifactId: skill.id,
      version: '1.0.0',
      status: 'published',
      createdAt: '2026-07-30T00:00:00.000Z',
      publishedAt: '2026-07-30T00:00:00.000Z',
      uploadGeneration: 1,
    }]
    installResponse = input => ({
      success: false as const,
      operationId: input.operationId,
      errorCode: 'creator_skill_conflict',
      stage: 'prepare' as const,
      diagnostic: '{}',
      retryable: false,
      conflicts: ['different_artifact'],
      conflictDetails: {
        existing: [{
          source: 'creator_space',
          artifactId: 'artifact-old',
          organizationId: 'organization-old',
          slug: 'review-skill',
          version: '0.9.0',
        }],
        incoming: {
          source: 'creator_space',
          artifactId: skill.id,
          organizationId,
          slug: 'review-skill',
          version: '1.0.0',
        },
      },
    })
    let confirmation = ''
    window.confirm = mock(message => {
      confirmation = String(message)
      return false
    })

    renderPanel(false, 'workspace-one')
    fireEvent.click((await screen.findByText('Review Skill')).closest('button')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    await waitFor(() => {
      expect(confirmation).toContain('different Creator works')
      expect(confirmation).toContain('artifact-old')
      expect(confirmation).toContain('0.9.0')
      expect(confirmation).toContain('skill-one')
      expect(confirmation).toContain('1.0.0')
      expect(confirmation.indexOf('artifact-old'))
        .toBeLessThan(confirmation.indexOf('skill-one'))
    })
  })

  it('switches immutable content and file tree with the selected history version', async () => {
    detailArtifact = {
      ...skill,
      latestPublishedVersion: '2.0.0',
    }
    detailVersions = [
      {
        id: 'version-one',
        artifactId: skill.id,
        version: '1.0.0',
        status: 'published',
        createdAt: '2026-07-30T00:00:00.000Z',
        uploadGeneration: 1,
      },
      {
        id: 'version-two',
        artifactId: skill.id,
        version: '2.0.0',
        status: 'published',
        createdAt: '2026-07-30T01:00:00.000Z',
        uploadGeneration: 1,
      },
    ]
    detailResponse = input => {
      const selected = input.version as string | undefined
      if (!selected) {
        return {
          success: true as const,
          artifact: detailArtifact,
          versions: detailVersions,
        }
      }
      if (input.referencePath) {
        return {
          success: true as const,
          artifact: detailArtifact,
          versions: detailVersions,
          selectedVersion: selected,
          reference: {
            path: input.referencePath,
            content: `Reference content for ${selected}`,
          },
        }
      }
      return {
        success: true as const,
        artifact: detailArtifact,
        versions: detailVersions,
        selectedVersion: selected,
        skillContent: `SKILL content for ${selected}`,
        fileTree: [{
          path: `references/version-${selected}.txt`,
          size: selected === '1.0.0' ? 10 : 20,
        }],
      }
    }

    renderPanel(false, 'workspace-one')
    fireEvent.click((await screen.findByText('Review Skill')).closest('button')!)
    expect(await screen.findByText('SKILL content for 2.0.0')).toBeTruthy()
    expect(await screen.findByText('references/version-2.0.0.txt')).toBeTruthy()

    const versionSelect = screen.getByRole('combobox')
    fireEvent.pointerDown(versionSelect, {
      button: 0,
      buttons: 1,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    const oldVersionOption = await screen.findByRole('option', { name: '1.0.0' })
    fireEvent.click(oldVersionOption)

    expect(await screen.findByText('SKILL content for 1.0.0')).toBeTruthy()
    expect(await screen.findByText('references/version-1.0.0.txt')).toBeTruthy()
    expect(screen.queryByText('Reference content for 1.0.0')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Preview as text' }))
    expect(await screen.findByText('Reference content for 1.0.0')).toBeTruthy()
    expect(detailInputs).toContainEqual({
      organizationId,
      artifactId: skill.id,
      version: '1.0.0',
    })
    expect(detailInputs).toContainEqual({
      organizationId,
      artifactId: skill.id,
      version: '1.0.0',
      referencePath: 'references/version-1.0.0.txt',
    })
  })

  it('selects the highest published stable SemVer when latest is absent', async () => {
    detailArtifact = {
      ...skill,
      latestPublishedVersion: undefined as never,
    }
    detailVersions = ['2.0.0', '10.0.0', '2.0.12'].map((version, index) => ({
      id: `version-${index}`,
      artifactId: skill.id,
      version,
      status: 'published',
      createdAt: `2026-07-30T0${index}:00:00.000Z`,
      uploadGeneration: 1,
    }))
    detailResponse = input => ({
      success: true as const,
      artifact: detailArtifact,
      versions: detailVersions,
      ...(input.version ? {
        selectedVersion: input.version,
        skillContent: `SKILL content for ${input.version}`,
        fileTree: [],
      } : {}),
    })

    renderPanel(false, 'workspace-one')
    fireEvent.click((await screen.findByText('Review Skill')).closest('button')!)

    expect(await screen.findByText('SKILL content for 10.0.0')).toBeTruthy()
  })

  it('does not let an older reference response pollute the selected version', async () => {
    detailArtifact = {
      ...skill,
      latestPublishedVersion: '2.0.0',
    }
    detailVersions = [
      {
        id: 'version-one',
        artifactId: skill.id,
        version: '1.0.0',
        status: 'published',
        createdAt: '2026-07-30T00:00:00.000Z',
        uploadGeneration: 1,
      },
      {
        id: 'version-two',
        artifactId: skill.id,
        version: '2.0.0',
        status: 'published',
        createdAt: '2026-07-30T01:00:00.000Z',
        uploadGeneration: 1,
      },
    ]
    const oldReference = deferred<Record<string, unknown>>()
    const currentReference = deferred<Record<string, unknown>>()
    detailResponse = input => {
      const selected = input.version as string | undefined
      if (!selected) {
        return {
          success: true,
          artifact: detailArtifact,
          versions: detailVersions,
        }
      }
      if (input.referencePath) {
        return selected === '1.0.0'
          ? oldReference.promise
          : currentReference.promise
      }
      return {
        success: true,
        artifact: detailArtifact,
        versions: detailVersions,
        selectedVersion: selected,
        skillContent: `SKILL content for ${selected}`,
        fileTree: [{
          path: `references/version-${selected}.txt`,
          size: 10,
        }],
      }
    }

    renderPanel(false, 'workspace-one')
    fireEvent.click((await screen.findByText('Review Skill')).closest('button')!)
    await screen.findByText('references/version-2.0.0.txt')

    const selectVersion = async (version: string) => {
      fireEvent.pointerDown(screen.getByRole('combobox'), {
        button: 0,
        buttons: 1,
        ctrlKey: false,
        pointerType: 'mouse',
      })
      fireEvent.click(await screen.findByRole('option', { name: version }))
    }

    await selectVersion('1.0.0')
    await screen.findByText('references/version-1.0.0.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Preview as text' }))

    await selectVersion('2.0.0')
    await screen.findByText('references/version-2.0.0.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Preview as text' }))

    await act(async () => {
      currentReference.resolve({
        success: true,
        artifact: detailArtifact,
        versions: detailVersions,
        selectedVersion: '2.0.0',
        reference: {
          path: 'references/version-2.0.0.txt',
          content: 'Current reference content',
        },
      })
    })
    expect(await screen.findByText('Current reference content')).toBeTruthy()

    await act(async () => {
      oldReference.resolve({
        success: true,
        artifact: detailArtifact,
        versions: detailVersions,
        selectedVersion: '1.0.0',
        reference: {
          path: 'references/version-1.0.0.txt',
          content: 'Stale reference content',
        },
      })
    })
    await waitFor(() => {
      expect(screen.getByText('Current reference content')).toBeTruthy()
      expect(screen.queryByText('Stale reference content')).toBeNull()
    })
  })

  it('localizes validation codes and keeps backend messages diagnostic-only', async () => {
    await i18n.changeLanguage('es')
    detailVersions = [{
      id: 'version-draft',
      artifactId: skill.id,
      version: '1.0.0',
      status: 'validation_failed',
      createdAt: '2026-07-30T00:00:00.000Z',
      uploadGeneration: 1,
      validationIssues: [{
        code: 'path_traversal',
        severity: 'error',
        path: '',
        message: 'Backend English path traversal detail',
      }],
    }]

    renderPanel(true)
    fireEvent.click((await screen.findByText('Review Skill')).closest('button')!)

    expect(await screen.findByText('Archivo de Skill')).toBeTruthy()
    expect(await screen.findByText(/recorrido fuera de la raíz/)).toBeTruthy()
    expect(screen.queryByText('Backend English path traversal detail')).toBeNull()
  })

  it('ignores an older artifact detail response that arrives after a newer selection', async () => {
    const secondSkill = {
      ...skill,
      id: 'skill-two',
      slug: 'second-skill',
      name: 'Second Skill',
    }
    artifactListResponse = () => ({
      success: true as const,
      artifacts: [skill, secondSkill],
    })
    const firstDetail = deferred<Record<string, unknown>>()
    const secondDetail = deferred<Record<string, unknown>>()
    detailResponse = input => (
      input.artifactId === skill.id
        ? firstDetail.promise
        : secondDetail.promise
    )

    renderPanel(false)
    await waitFor(() => {
      expect(detailInputs).toContainEqual({
        organizationId,
        artifactId: skill.id,
      })
    })
    fireEvent.click(screen.getByText('Second Skill').closest('button')!)
    await waitFor(() => {
      expect(detailInputs).toContainEqual({
        organizationId,
        artifactId: secondSkill.id,
      })
    })

    await act(async () => {
      secondDetail.resolve({
        success: true,
        artifact: secondSkill,
        versions: [],
      })
    })
    const detailPanel = screen.getByTestId('creator-artifact-detail')
    expect(within(detailPanel).getByRole('heading', { name: 'Second Skill' })).toBeTruthy()

    await act(async () => {
      firstDetail.resolve({
        success: true,
        artifact: skill,
        versions: [],
      })
    })
    await waitFor(() => {
      expect(within(detailPanel).getByRole('heading', { name: 'Second Skill' })).toBeTruthy()
      expect(within(detailPanel).queryByRole('heading', { name: 'Review Skill' })).toBeNull()
    })
  })

  it('starts a fresh detail request when returning to an artifact with a stale request in flight', async () => {
    const secondSkill = {
      ...skill,
      id: 'skill-two',
      slug: 'second-skill',
      name: 'Second Skill',
    }
    artifactListResponse = () => ({
      success: true as const,
      artifacts: [skill, secondSkill],
    })
    const staleDetail = deferred<Record<string, unknown>>()
    const currentDetail = deferred<Record<string, unknown>>()
    let firstSkillRequests = 0
    detailResponse = input => {
      if (input.artifactId === secondSkill.id) {
        return {
          success: true,
          artifact: secondSkill,
          versions: [],
        }
      }
      firstSkillRequests += 1
      return firstSkillRequests === 1 ? staleDetail.promise : currentDetail.promise
    }

    renderPanel(false)
    await waitFor(() => expect(firstSkillRequests).toBe(1))
    fireEvent.click(screen.getByText('Second Skill').closest('button')!)
    expect(await screen.findByRole('heading', { name: 'Second Skill' })).toBeTruthy()
    fireEvent.click(screen.getByText('Review Skill').closest('button')!)
    await waitFor(() => expect(firstSkillRequests).toBe(2))

    await act(async () => {
      currentDetail.resolve({
        success: true,
        artifact: skill,
        versions: [],
      })
    })
    const detailPanel = screen.getByTestId('creator-artifact-detail')
    expect(within(detailPanel).getByRole('heading', { name: 'Review Skill' })).toBeTruthy()

    await act(async () => {
      staleDetail.resolve({
        success: true,
        artifact: { ...skill, name: 'Stale Review Skill' },
        versions: [],
      })
    })
    await waitFor(() => {
      expect(within(detailPanel).getByRole('heading', { name: 'Review Skill' })).toBeTruthy()
      expect(within(detailPanel).queryByText('Stale Review Skill')).toBeNull()
    })
  })

  it('ignores an old organization detail response after the panel changes organizations', async () => {
    const nextOrganizationId = 'organization-two'
    const nextOrganizationSkill = {
      ...skill,
      organizationId: nextOrganizationId,
      id: 'organization-two-skill',
      slug: 'organization-two-skill',
      name: 'Organization Two Skill',
    }
    artifactListResponse = input => ({
      success: true as const,
      artifacts: input.organizationId === nextOrganizationId
        ? [nextOrganizationSkill]
        : [skill],
    })
    const oldDetail = deferred<Record<string, unknown>>()
    const nextDetail = deferred<Record<string, unknown>>()
    detailResponse = input => (
      input.organizationId === nextOrganizationId
        ? nextDetail.promise
        : oldDetail.promise
    )

    const view = renderPanel(false)
    await waitFor(() => {
      expect(detailInputs).toContainEqual({
        organizationId,
        artifactId: skill.id,
      })
    })
    view.rerender(panelTree(false, null, nextOrganizationId))
    await waitFor(() => {
      expect(detailInputs).toContainEqual({
        organizationId: nextOrganizationId,
        artifactId: nextOrganizationSkill.id,
      })
    })

    await act(async () => {
      nextDetail.resolve({
        success: true,
        artifact: nextOrganizationSkill,
        versions: [],
      })
    })
    const detailPanel = screen.getByTestId('creator-artifact-detail')
    expect(within(detailPanel).getByRole('heading', {
      name: 'Organization Two Skill',
    })).toBeTruthy()

    await act(async () => {
      oldDetail.resolve({
        success: true,
        artifact: skill,
        versions: [],
      })
    })
    await waitFor(() => {
      expect(within(detailPanel).getByRole('heading', {
        name: 'Organization Two Skill',
      })).toBeTruthy()
      expect(within(detailPanel).queryByRole('heading', { name: 'Review Skill' })).toBeNull()
    })
  })
})
