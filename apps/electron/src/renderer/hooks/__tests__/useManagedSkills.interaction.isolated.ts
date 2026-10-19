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
import type { ManagedSkillStatus } from '@polo-ai/shared/skills'

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
let setResponse: (input: Record<string, unknown>) => SetResponse | Promise<SetResponse>
const setInputs: Array<Record<string, unknown>> = []
let changeListeners: Array<(workspaceId?: string) => void> = []

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    listManagedSkills: async () => listResponse(),
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

  it('rolls a row back and rethrows the server error code on failure (SM-04r)', async () => {
    setResponse = () => ({ ok: false, errorCode: 'revision_conflict' })
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    const status = hook!.statusBySlug['review-skill']
    await expect(hook!.setSkillEnabled(status, false)).rejects.toThrow('revision_conflict')
    expect(hook?.statusBySlug['review-skill']?.enabled).toBe(true)
  })

  it('rolls a row back when the transport itself throws', async () => {
    renderProbe()
    await waitFor(() => expect(hook?.statusBySlug['review-skill']).toBeTruthy())
    setResponse = () => { throw new Error('transport gone') }
    const status = hook!.statusBySlug['review-skill']
    await expect(hook!.setSkillEnabled(status, false)).rejects.toThrow('transport gone')
    expect(hook?.statusBySlug['review-skill']?.enabled).toBe(true)
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
