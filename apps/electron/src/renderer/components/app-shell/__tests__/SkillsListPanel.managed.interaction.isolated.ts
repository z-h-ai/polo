import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import type { ManagedSkillStatus } from '@polo-ai/shared/skills'

GlobalRegistrator.register()
setupI18n()

// Controllable doubles for the two context seams the panel reads.
let productSpaceKind: 'personal' | 'enterprise' = 'personal'
let workspaceRemote = false
const setSkillEnabled = mock(async (_status: ManagedSkillStatus, _enabled: boolean) => {})
let statusBySlug: Record<string, {
  slug: string
  source: string
  enabled: boolean
  toggleable: boolean
  managed: boolean
  shadowedBuiltin: boolean
}> = {}
let inventoryRows: ReturnType<typeof skill>[] = []

mock.module('@/hooks/useManagedSkills', () => ({
  useManagedSkills: () => ({ statusBySlug, inventoryRows, revision: 0, refresh: async () => {}, setSkillEnabled, setSkillsEnabledBulk: async () => ({ succeeded: [], failed: [] }) }),
}))
mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => ({ activeProductSpace: { kind: productSpaceKind } }),
}))
mock.module('@/context/AppShellContext', () => ({
  useActiveWorkspace: () => ({ id: 'workspace-one', remoteServer: workspaceRemote }),
  useAppShellContext: () => ({
    workspaces: [{ id: 'workspace-one' }],
    activeWorkspaceId: 'workspace-one',
  }),
}))
mock.module('@/components/app-shell/SkillMenu', () => ({
  SkillMenu: () => createElement('span'),
}))
mock.module('@/components/app-shell/SendResourceToWorkspaceDialog', () => ({
  SendResourceToWorkspaceDialog: () => null,
}))
mock.module('@/components/ui/skill-avatar', () => ({
  SkillAvatar: () => createElement('span'),
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: () => null,
  getEditConfig: () => ({}),
}))
mock.module('@/components/ui/entity-list-empty', () => ({
  EntityListEmptyScreen: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
const toastError = mock((_message?: string, _options?: unknown) => {})
mock.module('sonner', () => ({
  toast: { error: toastError, success: mock(() => {}) },
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { SkillsListPanel } = await import('../../app-shell/SkillsListPanel')
const { skillSelection } = await import('@/hooks/useEntitySelection')
const { ActionRegistryProvider } = await import('@/actions')

function skill(
  slug: string,
  name: string,
  source: 'bundled' | 'global' | 'workspace' | 'project',
  extra: Record<string, unknown> = {},
) {
  return {
    slug,
    metadata: { name, description: `${name} description` },
    content: 'Instructions.',
    path: `/workspace/skills/${slug}`,
    source,
    ...extra,
  }
}

const rows = [
  // Plain user-tier workspace skill: the only row with a live toggle.
  skill('review-skill', 'Review Skill', 'workspace'),
  // Bundled rows render a badge and never a toggle (SM-18a).
  skill('bundled-one', 'Bundled One', 'bundled'),
  // A user entry whose slug shadows a bundled skill: no toggle, badge only.
  skill('over-builtin', 'Shadow User', 'workspace'),
  // A legacy creator installation: managed, no toggle anywhere (SM-18g).
  skill('managed-skill', 'Managed Skill', 'workspace', {
    creatorInstallation: {
      artifactId: 'artifact-one',
      organizationId: 'organization-one',
      slug: 'managed-skill',
      version: '1.0.0',
      archiveChecksum: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      installedAt: '2026-07-30T00:00:00.000Z',
    },
  }),
]

const enabledRow = {
  slug: 'review-skill', source: 'workspace', enabled: true, toggleable: true, managed: false, shadowedBuiltin: false,
}
const bundledRow = {
  slug: 'bundled-one', source: 'bundled', enabled: true, toggleable: false, managed: false, shadowedBuiltin: false,
}
const shadowRow = {
  slug: 'over-builtin', source: 'workspace', enabled: true, toggleable: false, managed: false, shadowedBuiltin: true,
}
const managedRow = {
  slug: 'managed-skill', source: 'workspace', enabled: true, toggleable: false, managed: true, shadowedBuiltin: false,
}

function SelectionProbe() {
  const ids = skillSelection.useSelectedIds()
  return createElement('div', { 'data-testid': 'selected-ids' }, [...ids].sort().join(','))
}

function renderPanel() {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(
      ActionRegistryProvider,
      null,
      createElement(SkillsListPanel, {
        skills: rows,
        onDeleteSkill: () => {},
        onSkillClick: () => {},
        workspaceId: 'workspace-one',
      }),
      createElement(SelectionProbe),
    ),
  ))
}

function rowFor(name: string) {
  return screen.getByRole('option', { name: new RegExp(name) })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  productSpaceKind = 'personal'
  workspaceRemote = false
  toastError.mockClear()
  setSkillEnabled.mockClear()
  inventoryRows = []
  statusBySlug = {
    'review-skill': enabledRow,
    'bundled-one': bundledRow,
    'over-builtin': shadowRow,
    'managed-skill': managedRow,
  }
})

afterEach(() => {
  cleanup()
})

describe('SkillsListPanel managed enablement', () => {
  it('gives only the toggleable user-tier row a switch', () => {
    renderPanel()
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(1)
    expect(switches[0].getAttribute('aria-label')).toBe('Disable skill: Review Skill')
  })

  it('marks shadowedBuiltin rows with the badge and no toggle (K1/SM-18e)', () => {
    renderPanel()
    expect(screen.getByText('covers built-in')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /Shadow User/ })).toBeNull()
  })

  it('marks bundled rows as bundled and never toggleable (SM-18a)', () => {
    renderPanel()
    expect(screen.getByText('bundled', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /Bundled One/ })).toBeNull()
  })

  it('gives legacy creator-installed rows no toggle (SM-18g)', () => {
    renderPanel()
    expect(screen.queryByRole('switch', { name: /Managed Skill/ })).toBeNull()
  })

  it('excludes bundled, managed and shadowedBuiltin rows from multi-select (K8)', () => {
    renderPanel()
    fireEvent.mouseDown(rowFor('Bundled One'), { metaKey: true, button: 0 })
    fireEvent.mouseDown(rowFor('Managed Skill'), { metaKey: true, button: 0 })
    fireEvent.mouseDown(rowFor('Shadow User'), { metaKey: true, button: 0 })
    expect(screen.getByTestId('selected-ids').textContent).toBe('')
    fireEvent.mouseDown(rowFor('Review Skill'), { metaKey: true, button: 0 })
    expect(screen.getByTestId('selected-ids').textContent).toBe('review-skill')
  })

  it('writes through the hook when the switch flips', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable skill: Review Skill' }))
    await waitFor(() => expect(setSkillEnabled).toHaveBeenCalledTimes(1))
    expect(setSkillEnabled.mock.calls[0][0]).toMatchObject({ slug: 'review-skill' })
    expect(setSkillEnabled.mock.calls[0][1]).toBe(false)
  })

  it('toasts Settings not saved when the write fails (SM-04r)', async () => {
    setSkillEnabled.mockImplementation(async () => { throw new Error('revision_conflict') })
    renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable skill: Review Skill' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toBe('Settings not saved')
  })

  it('toasts the mapped friendly message, not the raw error code (M3)', async () => {
    const consoleError = mock(() => {})
    const saved = console.error
    console.error = consoleError
    setSkillEnabled.mockImplementation(async () => { throw new Error('revision_conflict') })
    renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable skill: Review Skill' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    console.error = saved
    expect(toastError.mock.calls[0][0]).toBe('Settings not saved')
    expect((toastError.mock.calls[0][1] as { description: string }).description).toBe(
      'The skill list just changed elsewhere. Try again.',
    )
    // The raw code stays available for diagnostics.
    expect(consoleError).toHaveBeenCalledWith(
      '[skills] Managed skill enablement write failed:',
      'revision_conflict',
    )
  })

  it('keeps a disabled inventory-only row listed with its switch (B1)', async () => {
    // The filtered composer list no longer contains the disabled row; only the
    // unfiltered inventory does. The panel must still render it (B1).
    inventoryRows = [...rows, skill('archived-skill', 'Archived Skill', 'workspace')]
    statusBySlug = {
      ...statusBySlug,
      'archived-skill': {
        slug: 'archived-skill', source: 'workspace', enabled: false, toggleable: true, managed: false, shadowedBuiltin: false,
      },
    }
    renderPanel()
    expect(rowFor('Archived Skill')).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: 'Enable skill: Archived Skill' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(setSkillEnabled).toHaveBeenCalledTimes(1))
    expect(setSkillEnabled.mock.calls[0][0]).toMatchObject({ slug: 'archived-skill' })
    expect(setSkillEnabled.mock.calls[0][1]).toBe(true)
  })

  it('does not duplicate rows present in both filtered and unfiltered lists (B1)', () => {
    inventoryRows = [...rows]
    renderPanel()
    expect(screen.getAllByRole('option', { name: /Review Skill/ })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: /Bundled One/ })).toHaveLength(1)
  })

  it('renders a disabled switch with the scope hint outside the personal/local scope (K3)', () => {
    productSpaceKind = 'enterprise'
    renderPanel()
    const blocked = screen.getByRole('switch', { name: 'Disable skill: Review Skill' })
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(blocked.getAttribute('aria-checked')).toBe('true')
    expect(blocked.getAttribute('title')).toBe(
      'Skills can only be enabled or disabled for your personal space in a local workspace.',
    )
  })

  it('drives the scope-blocked aria-checked state from the row status (N2)', () => {
    productSpaceKind = 'enterprise'
    statusBySlug = { 'review-skill': { ...enabledRow, enabled: false } }
    renderPanel()
    const blocked = screen.getByRole('switch', { name: 'Enable skill: Review Skill' })
    expect(blocked.getAttribute('aria-checked')).toBe('false')
  })

  it('treats a remote workspace as out of scope too (K3)', () => {
    workspaceRemote = true
    renderPanel()
    expect(screen.getByRole('switch', { name: 'Disable skill: Review Skill' }).getAttribute('aria-disabled')).toBe('true')
  })
})
