import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { createStore, Provider } from 'jotai'
import type { LoadedSkill, ManagedSkillStatus } from '@polo-ai/shared/skills'

GlobalRegistrator.register()

type ListResponse = {
  ok: boolean
  workspaceId?: string
  revision?: number
  items?: Array<{
    slug: string
    source: string
    enabled: boolean
    toggleable: boolean
    managed: boolean
    shadowedBuiltin: boolean
  }>
}
type SetResponse = { ok: boolean; slug?: string; enabled?: boolean; revision?: number; errorCode?: string }

let listResponse: () => ListResponse | Promise<ListResponse>
let unfilteredRowsResponse: () => LoadedSkill[] | Promise<LoadedSkill[]>
let setResponse: (input: Record<string, unknown>) => SetResponse | Promise<SetResponse>
const setInputs: Array<Record<string, unknown>> = []
let changeListeners: Array<(workspaceId?: string) => void> = []

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    listManagedSkills: async () => listResponse(),
    getSkillsUnfiltered: async () => unfilteredRowsResponse(),
    setManagedSkillEnablement: async (input: Record<string, unknown>) => {
      setInputs.push(input)
      return setResponse(input)
    },
    onSkillsChanged: (listener: (workspaceId?: string) => void) => {
      changeListeners.push(listener)
      return () => {}
    },
  },
})

const { cleanup, render, waitFor } = await import('@testing-library/react')
const { useManagedSkills } = await import('../useManagedSkills')

type Hook = ReturnType<typeof useManagedSkills>
let hook: Hook | null = null

function Probe() {
  hook = useManagedSkills('ws-one')
  return null
}

function renderProbe() {
  render(createElement(Provider, { store: createStore() }, createElement(Probe)))
}

const userRow: ManagedSkillStatus = {
  slug: 'review-skill',
  source: 'workspace',
  enabled: true,
  toggleable: true,
  managed: false,
  shadowedBuiltin: false,
}

beforeEach(() => {
  setInputs.length = 0
  changeListeners = []
  listResponse = () => ({ ok: true, workspaceId: 'ws-one', revision: 0, items: [userRow] })
  unfilteredRowsResponse = () => []
  setResponse = () => ({ ok: true, slug: 'review-skill', enabled: false, revision: 1 })
})

afterEach(() => {
  cleanup()
})

describe('useManagedSkills', () => {
  it('loads the inventory for the active workspace', async () => {
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toEqual(userRow))
    expect(hook?.revision).toBe(0)
  })

  it('flips a row optimistically and adopts the server revision on success', async () => {
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    const status = hook!.statusBySlug['review-skill']
    await hook!.setSkillEnabled(status, false)
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(false))
    expect(hook?.revision).toBe(1)
    expect(setInputs[0]).toEqual({
      workspaceId: 'ws-one',
      slug: 'review-skill',
      source: 'workspace',
      enabled: false,
      expectedRevision: 0,
    })
  })

  it('loads the unfiltered management rows for the panel merge (B1)', async () => {
    const disabledRow = {
      slug: 'archived-skill',
      metadata: { name: 'Archived Skill', description: 'Archived Skill description' },
      content: 'Instructions.',
      path: '/workspace/skills/archived-skill',
      source: 'workspace',
    } as LoadedSkill
    unfilteredRowsResponse = () => [disabledRow]
    renderProbe()
    await waitFor(() => expect(hook?.inventoryRows.map(row => row.slug)).toEqual(['archived-skill']))
    expect(hook?.statusBySlug['review-skill']).toEqual(userRow)
  })

  it('refreshes the unfiltered rows when skills.CHANGED fires (B1)', async () => {
    let rowsCalls = 0
    unfilteredRowsResponse = () => {
      rowsCalls += 1
      return [{ slug: `row-${rowsCalls}` } as LoadedSkill]
    }
    renderProbe()
    await waitFor(() => expect(hook?.inventoryRows[0]?.slug).toBe('row-1'))
    changeListeners.forEach(listener => listener('ws-one'))
    await waitFor(() => expect(hook?.inventoryRows[0]?.slug).toBe('row-2'))
  })

  it('threads the latest revision through back-to-back single writes (M1)', async () => {
    const secondRow = { ...userRow, slug: 'other-skill' }
    const applied: string[] = []
    listResponse = () => ({ ok: true, workspaceId: 'ws-one', revision: applied.length, items: [userRow, secondRow] })
    setResponse = (input) => {
      applied.push(String(input.slug))
      return { ok: true, slug: String(input.slug), enabled: false, revision: applied.length }
    }
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['other-skill']).toBeTruthy())
    const first = hook!.statusBySlug['review-skill']
    const second = hook!.statusBySlug['other-skill']
    // Both toggles land inside the same render window, before the first RPC
    // resolves — the second write must echo the revision the first produced.
    await Promise.all([
      hook!.setSkillEnabled(first, false),
      hook!.setSkillEnabled(second, false),
    ])
    expect(setInputs.map(input => input.expectedRevision)).toEqual([0, 1])
  })

  it('adopts the revision carried by a conflict response so the retry succeeds (M1)', async () => {
    let documentRevision = 0
    listResponse = () => ({ ok: true, workspaceId: 'ws-one', revision: documentRevision, items: [userRow] })
    setResponse = (input) => {
      if (input.expectedRevision === 0 && documentRevision === 0) {
        documentRevision = 7
        return { ok: false as const, errorCode: 'revision_conflict', revision: 7 }
      }
      return { ok: true as const, slug: 'review-skill', enabled: false, revision: 8 }
    }
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    const status = hook!.statusBySlug['review-skill']
    await expect(hook!.setSkillEnabled(status, false)).rejects.toThrow('revision_conflict')
    // The retry echoes the adopted revision instead of the stale one, and succeeds.
    await hook!.setSkillEnabled(hook!.statusBySlug['review-skill'], false)
    expect(setInputs[1]?.expectedRevision).toBe(7)
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(false))
  })

  it('rolls a row back and rethrows the server error code on failure (SM-04r)', async () => {
    setResponse = () => ({ ok: false, errorCode: 'revision_conflict' })
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    const status = hook!.statusBySlug['review-skill']
    await expect(hook!.setSkillEnabled(status, false)).rejects.toThrow('revision_conflict')
    expect(hook?.statusBySlug['review-skill']?.enabled).toBe(true)
  })

  it('restores the pre-toggle value when the transport itself throws (SM-04r)', async () => {
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    setResponse = () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('transport gone')), 30)
    })
    const status = hook!.statusBySlug['review-skill']
    const pending = hook!.setSkillEnabled(status, false)
    // Attach the rejection handler before observing the optimistic flip so the
    // interim rejection stays handled.
    const rejection = expect(pending).rejects.toThrow('transport gone')
    // The optimistic flip is observable while the write is in flight...
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(false))
    await rejection
    // ...and the rollback puts the row back instead of leaving it flipped.
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(true))
  })

  it('serializes a bulk write so each item carries the previous revision', async () => {
    const secondRow = { ...userRow, slug: 'other-skill' }
    const applied: string[] = []
    listResponse = () => ({
      ok: true,
      workspaceId: 'ws-one',
      revision: applied.length,
      items: [userRow, secondRow].map(row => ({ ...row, enabled: !applied.includes(row.slug) })),
    })
    setResponse = (input) => {
      applied.push(String(input.slug))
      return { ok: true, slug: String(input.slug), enabled: false, revision: applied.length }
    }
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['other-skill']).toBeTruthy())
    const outcome = await hook!.setSkillsEnabledBulk(
      [hook!.statusBySlug['review-skill'], hook!.statusBySlug['other-skill']],
      false,
    )
    expect(outcome).toEqual({ succeeded: ['review-skill', 'other-skill'], failed: [] })
    expect(setInputs.map(input => input.expectedRevision)).toEqual([0, 1])
    // The post-write refresh adopts the server list, which now reports both rows off.
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(false))
    expect(hook?.statusBySlug['other-skill']?.enabled).toBe(false)
  })

  it('reports and rolls back only the failed rows of a bulk write (SM-06r)', async () => {
    const secondRow = { ...userRow, slug: 'other-skill' }
    const applied: string[] = []
    listResponse = () => ({
      ok: true,
      workspaceId: 'ws-one',
      revision: applied.length,
      items: [userRow, secondRow].map(row => ({ ...row, enabled: !applied.includes(row.slug) })),
    })
    setResponse = (input) => (
      input.slug === 'other-skill'
        ? { ok: false, errorCode: 'revision_conflict' }
        : (applied.push(String(input.slug)), { ok: true, slug: 'review-skill', enabled: false, revision: applied.length })
    )
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['other-skill']).toBeTruthy())
    const outcome = await hook!.setSkillsEnabledBulk(
      [hook!.statusBySlug['review-skill'], hook!.statusBySlug['other-skill']],
      false,
    )
    expect(outcome).toEqual({ succeeded: ['review-skill'], failed: ['other-skill'] })
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(false))
    expect(hook?.statusBySlug['other-skill']?.enabled).toBe(true)
  })

  it('refreshes when skills.CHANGED fires for the same workspace (K5)', async () => {
    let listCalls = 0
    listResponse = () => {
      listCalls += 1
      return {
        ok: true,
        workspaceId: 'ws-one',
        revision: listCalls - 1,
        items: [{ ...userRow, enabled: listCalls === 1 }],
      }
    }
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(true))
    changeListeners.forEach(listener => listener('ws-one'))
    await waitFor(() => expect(hook?.statusBySlug['review-skill']?.enabled).toBe(false))
    expect(hook?.revision).toBe(1)
  })

  it('ignores skills.CHANGED broadcasts from other workspaces', async () => {
    let listCalls = 0
    listResponse = () => {
      listCalls += 1
      return { ok: true, workspaceId: 'ws-one', revision: 0, items: [userRow] }
    }
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    changeListeners.forEach(listener => listener('ws-other'))
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(listCalls).toBe(1)
  })
})
