import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

/**
 * POO-205 CreateProjectDialog (isolated happy-dom render; rewritten from the
 * POO-196 R3 D-B surface — Spec Q1/Q3: a project is a LIGHTWEIGHT entity
 * inside one organization; the client-side-enterprise surface — payer terms,
 * phone verification, idempotency keys, receipt queries — is RETIRED).
 * Proven contracts:
 *
 * - the form is name (required) + optional purpose ONLY: no owner input
 *   (the acting account owns the project by construction), no responsibility
 *   consent, no receipt channel — every failure is definite and the form
 *   stays editable;
 * - the command exists ONLY while an ORGANIZATION space is committed; with
 *   the personal space committed the dialog renders the guidance face and an
 *   explicit「前往组织空间」action for the sole organization;
 * - the wire scope is the committed-organization envelope and the command is
 *   the honest {name, purpose?} — nothing is derived or padded;
 * - success hands the PROJECT to the lightweight entry exactly once and
 *   closes the dialog; reopening offers a fresh form (the draft never
 *   carries consent-like state, and the created project is never re-created);
 * - local field bounds answer with their specific errors and never reach the
 *   server; an IME composition Enter never submits.
 */

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

mock.module('@/components/ui/client-workbench', () => ({
  clientWorkbenchFocusClassName: '',
  clientWorkbenchDialogClassName: '',
  clientWorkbenchOverlayClassName: '',
  clientWorkbenchMenuClassName: '',
  clientWorkbenchPrimaryClassName: '',
  clientWorkbenchButtonClassName: '',
  clientWorkbenchDestructiveClassName: '',
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { CreateProjectDialog } = await import('../CreateProjectDialog')

const ACCOUNT_ID = 'account-create-1'
const PERSONAL_ID = 'space-personal'
const ORG_ID = 'space-org-current'
const ORG_ENTERPRISE_ID = 'ent-org-current'

const personalSpace = {
  id: PERSONAL_ID,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary

const orgSpace = {
  id: ORG_ID,
  kind: 'enterprise',
  enterpriseId: ORG_ENTERPRISE_ID,
  name: '华东区销售组织',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: ORG_ENTERPRISE_ID },
} as unknown as ProductSpaceSummary

const CREATED_PROJECT = {
  id: 'pj-created',
  organizationEnterpriseId: ORG_ENTERPRISE_ID,
  organizationProductSpaceId: ORG_ID,
  name: '华东区销售资料库',
  myRole: 'owner' as const,
  memberCount: 1,
  contractVersion: 'poo205-contract-r1',
  purpose: undefined,
  instructions: undefined,
  createdByAccountId: ACCOUNT_ID,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
}

interface CreateHarness {
  createCalls: Array<Record<string, unknown>>
}

function makeHarness(options: {
  /** One entry per create call: undefined resolves `created`, an object
   * rejects with that code (missing code = transport-level loss). */
  createScript?: Array<{ code?: string } | undefined>
} = {}): CreateHarness {
  const harness: CreateHarness = { createCalls: [] }
  let createIndex = 0
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmCreateProject: async (input: Record<string, unknown>) => {
        harness.createCalls.push(input)
        const script = options.createScript ?? [undefined]
        const step = script[createIndex++]
        if (step) {
          throw Object.assign(new Error(step.code ?? 'transport lost'), step.code ? { code: step.code } : {})
        }
        return {
          contractVersion: 'poo205-contract-r1',
          project: { ...CREATED_PROJECT, name: String((input.command as Record<string, unknown>).name) },
        }
      },
    },
  })
  return harness
}

function renderCreate(options: {
  harness?: CreateHarness
  createScript?: Array<{ code?: string } | undefined>
  activeSpace?: Record<string, unknown>
  productSpaces?: Array<Record<string, unknown>>
  onCreated?: (accountId: string, project: Record<string, unknown>) => void
} = {}) {
  const harness = options.harness ?? makeHarness({ createScript: options.createScript })
  const accountId = ACCOUNT_ID
  const activeSpace = options.activeSpace ?? orgSpace
  const productSpaces = options.productSpaces ?? [personalSpace, orgSpace]
  const onOpenChange = mock(() => {})
  const onSelectProductSpace = mock(() => {})
  const onCreated = options.onCreated ?? mock(() => {})
  const Provider = ProductSpaceProvider as unknown as (props: Record<string, unknown>) => ReactElement
  const Dialog = CreateProjectDialog as unknown as (props: Record<string, unknown>) => ReactElement
  const buildTree = (open: boolean) => createElement(
    I18nextProvider,
    { i18n },
    createElement(
      Provider,
      {
        value: {
          accountId,
          activeProductSpaceId: activeSpace.id as string,
          activeProductSpace: activeSpace,
          productSpaces,
          allProductSpaces: productSpaces,
          personalProductSpaceId: PERSONAL_ID,
          productSpaceContextKey: JSON.stringify(['product-space', 1, accountId, activeSpace.id as string]),
          contextVersion: 1,
          pendingSwitch: null,
          onSelectProductSpace,
          onRequestSwitch: mock(() => Promise.resolve()),
          onRefreshProductSpaces: async () => productSpaces as unknown as ProductSpaceSummary[],
          onOpenCreateProject: mock(() => {}),
          onConfirmStopAndSwitch: mock(() => {}),
          onRetryFailedStops: mock(() => {}),
          onRetryTargetLoad: mock(() => {}),
          onCancelSwitch: mock(() => {}),
          onDismissTargetAccessLost: mock(() => {}),
          onStopSwitchExecution: mock(() => {}),
        },
      },
      createElement(Dialog, { open, onOpenChange, onCreated }),
    ),
  )
  const view = render(buildTree(true))
  return {
    harness,
    onOpenChange,
    onSelectProductSpace,
    onCreated,
    setOpen: (open: boolean) => view.rerender(buildTree(open)),
  }
}

function fillName(name = '华东区销售资料库') {
  fireEvent.change(screen.getByTestId('create-project-name-input'), { target: { value: name } })
}

function fillPurpose(purpose: string) {
  fireEvent.change(screen.getByTestId('create-project-purpose-input'), { target: { value: purpose } })
}

function submitForm() {
  fireEvent.submit(document.getElementById('create-project-form')!)
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(cleanup)

describe('CreateProjectDialog (POO-205 lightweight create, Spec Q3)', () => {
  it('the minimal form submits the committed-organization scope with the honest command; success hands the PROJECT to the entry and closes', async () => {
    const { harness, onCreated, onOpenChange, onSelectProductSpace } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    // Nothing left the renderer before the explicit submit.
    expect(harness.createCalls).toHaveLength(0)
    fillName()
    fillPurpose('集中管理区域销售资料')
    submitForm()

    await waitFor(() => expect(harness.createCalls).toHaveLength(1))
    const call = harness.createCalls[0]!
    // The committed-organization envelope, re-proved by the trusted side.
    expect(call).toMatchObject({
      accountId: ACCOUNT_ID,
      productSpaceId: ORG_ID,
      organizationEnterpriseId: ORG_ENTERPRISE_ID,
    })
    // The command is the honest {name, purpose} — no payer facts, no owner
    // input, no idempotency key, no payment terms.
    expect(call.command).toEqual({ name: '华东区销售资料库', purpose: '集中管理区域销售资料' })

    // Success: the dialog closes and the lightweight entry receives the
    // created PROJECT (never a space switch here).
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect((onCreated as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls[0]?.[0]).toBe(ACCOUNT_ID)
    expect((onCreated as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls[0]?.[1]).toMatchObject({ id: 'pj-created', name: '华东区销售资料库' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // NO space switch request rides the create success.
    expect(onSelectProductSpace).not.toHaveBeenCalled()
  })

  it('an empty purpose is legal and stays absent from the wire; the project name is required', async () => {
    const { harness, onCreated } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    // The name is required: an empty submit never reaches the server.
    submitForm()
    await waitFor(() => expect(screen.getByTestId('create-project-dialog').textContent).toContain('请填写项目名称'))
    expect(harness.createCalls).toHaveLength(0)

    fillName()
    submitForm()
    await waitFor(() => expect(harness.createCalls).toHaveLength(1))
    // P5 (retained): the optional purpose crosses as ABSENT, never padded.
    expect(harness.createCalls[0]!.command).toEqual({ name: '华东区销售资料库' })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  })

  it('local bounds: a 257-char name and a 2001-char purpose each get their specific error and never reach the server', async () => {
    const { harness } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    fillName('名'.repeat(257))
    fillPurpose('介'.repeat(2001))
    submitForm()

    const dialog = screen.getByTestId('create-project-dialog')
    expect(dialog.textContent).toContain('项目名称不能超过 256 个字符')
    expect(dialog.textContent).toContain('介绍不能超过 2000 个字符')
    expect(harness.createCalls).toHaveLength(0)
  })

  it('an IME composition Enter never submits', async () => {
    const { harness } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    fillName()
    const form = document.getElementById('create-project-form')!
    fireEvent.keyDown(form, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(harness.createCalls).toHaveLength(0)
  })

  it('every failure is DEFINITE: the form stays editable with the classified copy, and an explicit retry sends a fresh request', async () => {
    const { harness, onCreated } = renderCreate({
      createScript: [{ code: 'prj_forbidden' }, undefined],
    })
    await screen.findByTestId('create-project-dialog')

    fillName()
    submitForm()
    await waitFor(() => expect(harness.createCalls).toHaveLength(1))
    expect(await screen.findByTestId('create-project-submit-error')).toBeTruthy()
    expect(screen.getByTestId('create-project-submit-error').textContent).toContain('没有权限')
    // The form stays editable (no receipt channel exists to wait on).
    expect(screen.getByTestId('create-project-dialog').getAttribute('data-phase')).toBe('form')
    expect(screen.getByTestId('create-project-name-input')).toBeTruthy()
    expect(onCreated).not.toHaveBeenCalled()

    // An explicit retry sends a FRESH request (no stored key, no replay).
    fillName()
    submitForm()
    await waitFor(() => expect(harness.createCalls).toHaveLength(2))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  })

  it('after the success closes the dialog, reopening offers a FRESH form', async () => {
    const { harness, onOpenChange, onCreated, setOpen } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    fillName()
    submitForm()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    setOpen(false)
    await waitFor(() => expect(screen.queryByTestId('create-project-dialog')).toBeNull())
    setOpen(true)

    const reopened = await screen.findByTestId('create-project-dialog')
    expect((screen.getByTestId('create-project-name-input') as HTMLInputElement).value).toBe('')
    expect(harness.createCalls).toHaveLength(1)
    expect(reopened.textContent).not.toContain('项目已创建')
  })

  it('a transport-level loss is also definite: classified as the generic failure, the form stays editable', async () => {
    const { harness } = renderCreate({ createScript: [{}] })
    await screen.findByTestId('create-project-dialog')

    fillName()
    submitForm()
    expect(await screen.findByTestId('create-project-submit-error')).toBeTruthy()
    expect(screen.getByTestId('create-project-dialog').getAttribute('data-phase')).toBe('form')
    // Exactly ONE request left the renderer (no automatic resend, no
    // receipt query — the whole POO-196 recovery surface is retired).
    expect(harness.createCalls).toHaveLength(1)
    expect(screen.queryByTestId('create-project-recovery')).toBeNull()
    expect(screen.queryByTestId('create-project-query-receipt')).toBeNull()
  })
})

describe('CreateProjectDialog (POO-205 committed-organization gating)', () => {
  it('with the personal space committed there is NO form — the guidance face offers the sole organization', async () => {
    const { harness, onSelectProductSpace } = renderCreate({
      activeSpace: personalSpace,
      productSpaces: [personalSpace, orgSpace],
    })
    await screen.findByTestId('create-project-dialog')

    // The face never renders a form that can only fail.
    expect(screen.queryByTestId('create-project-name-input')).toBeNull()
    expect(screen.getByTestId('create-project-org-required')).toBeTruthy()
    expect(screen.getByTestId('create-project-go-organization').textContent).toContain('华东区销售组织')

    // The guidance action is an explicit switch to the organization.
    fireEvent.click(screen.getByTestId('create-project-go-organization'))
    expect(onSelectProductSpace).toHaveBeenCalledWith(ORG_ID)
    // No wire call ever left the renderer.
    expect(harness.createCalls).toHaveLength(0)
  })

  it('with SEVERAL organizations the guidance stays neutral — the dialog never silently picks one', async () => {
    const orgB = {
      id: 'space-org-b',
      kind: 'enterprise',
      enterpriseId: 'ent-org-b',
      name: '另一个组织',
      role: 'member',
      accessMode: 'active',
      payer: { kind: 'enterprise', enterpriseId: 'ent-org-b' },
    }
    renderCreate({
      activeSpace: personalSpace,
      productSpaces: [personalSpace, orgSpace, orgB as unknown as ProductSpaceSummary],
    })
    await screen.findByTestId('create-project-dialog')

    expect(screen.getByTestId('create-project-org-required')).toBeTruthy()
    expect(screen.queryByTestId('create-project-go-organization')).toBeNull()
  })
})
