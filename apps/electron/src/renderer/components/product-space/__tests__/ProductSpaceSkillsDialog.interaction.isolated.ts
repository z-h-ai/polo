import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

GlobalRegistrator.register()
let context: any
let catalog: any
let getCatalog: (id: string) => Promise<any>
let setEnabled: (...args: any[]) => Promise<any>
let prepare: (...args: any[]) => Promise<any>
mock.module('@/context/ProductSpaceContext', () => ({ useOptionalProductSpaceContext: () => context }))
mock.module('@/context/AppShellContext', () => ({ useActiveWorkspace: () => ({ id: 'workspace' }) }))
mock.module('@/components/ui/client-workbench', () => ({ clientWorkbenchDialogClassName: '', clientWorkbenchButtonClassName: '' }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: any) => options?.defaultValue ?? _key }) }))
const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react')
const { ProductSpaceSkillsDialog } = await import('../ProductSpaceSkillsDialog')
const skill = { kind: 'skill', catalogEntryId: 'entry', artifactInstanceId: 'instance', name: 'Team helper', description: 'Use for team reports', availability: 'available', version: { versionId: 'v1', version: '1.0.0' }, enabled: false, sources: [{ kind: 'creator_circle', circleId: 'circle', name: 'My circle' }], permissions: [] }
beforeEach(() => {
  context = { accountId: 'account', contextVersion: 1, activeProductSpace: { id: 'personal', kind: 'personal', name: 'My space', accessMode: 'active' } }
  catalog = { success: true, contractVersion: 1, productSpaceId: 'personal', catalogRevision: '1', entries: [{ kind: 'built_in_app', builtInAppId: 'polo_assistant', catalogEntryId: 'assistant', name: 'Polo', description: '', availability: 'available' }, { ...skill }] }
  getCatalog = async () => catalog
  setEnabled = async (_space, instance, enabled) => { catalog.entries[1] = { ...catalog.entries[1], enabled }; return { success: true, mutation: { productSpaceId: 'personal', artifactInstanceId: instance, enabled }, catalog } }
  prepare = async () => ({ success: true })
  Object.assign(window, { electronAPI: { productSpaceGetCatalog: (id: string) => getCatalog(id), getSkills: async () => [], productSpaceSetSkillEnablement: (...args: any[]) => setEnabled(...args), productSpaceInstallSkill: (...args: any[]) => prepare(...args) } })
})
afterEach(cleanup)
it('keeps authorization, my enablement and device preparation distinct', async () => {
  let preparations = 0
  prepare = async () => { preparations++; return { success: true } }
  render(createElement(ProductSpaceSkillsDialog, { onClose() {} }))
  await screen.findByText('Team helper')
  expect((screen.getByRole('button', { name: 'Download / update' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
  await screen.findByRole('button', { name: 'Disable' })
  expect(preparations).toBe(0)
  expect(screen.getByText(/Enabled for me/).textContent).toContain('Current version not prepared')
  fireEvent.click(screen.getByRole('button', { name: 'Download / update' }))
  await waitFor(() => expect(preparations).toBe(1))
})
it('never puts a late prior-space response on the new space screen', async () => {
  let finish!: (result: any) => void
  const old = structuredClone(catalog)
  getCatalog = () => new Promise(resolve => { finish = resolve })
  const rendered = render(createElement(ProductSpaceSkillsDialog, { onClose() {} }))
  await waitFor(() => expect(typeof finish).toBe('function'))
  context = { ...context, contextVersion: 2, activeProductSpace: { id: 'enterprise', kind: 'enterprise', name: 'Company space', accessMode: 'active' } }
  getCatalog = async () => ({ ...old, productSpaceId: 'enterprise', entries: [old.entries[0]] })
  rendered.rerender(createElement(ProductSpaceSkillsDialog, { onClose() {} }))
  await act(async () => { finish(old) })
  await screen.findByText('No skills are available in this space.')
  expect(screen.queryByText('Team helper')).toBeNull()
})
it('blocks preparation in a restricted space even when an enabled row exists', async () => {
  context.activeProductSpace.accessMode = 'read_only'
  catalog.entries[1].enabled = true
  let calls = 0
  prepare = async () => { calls++; return { success: true } }
  render(createElement(ProductSpaceSkillsDialog, { onClose() {} }))
  await screen.findByText('Team helper')
  fireEvent.click(screen.getByRole('button', { name: 'Download / update' }))
  expect(calls).toBe(0)
})
it('shows failed preparation without claiming the new version is installed', async () => {
  catalog.entries[1].enabled = true
  prepare = async () => ({ success: false, errorCode: 'archive_checksum_mismatch' })
  render(createElement(ProductSpaceSkillsDialog, { onClose() {} }))
  await screen.findByText('Team helper')
  fireEvent.click(screen.getByRole('button', { name: 'Download / update' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('Current version prepared')).toBeNull()
  expect(screen.getByText(/Current version not prepared/)).toBeTruthy()
})
