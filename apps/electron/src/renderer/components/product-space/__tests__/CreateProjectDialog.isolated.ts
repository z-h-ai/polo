import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import { clientEnterpriseCreatePresentation } from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 R3 CreateProjectDialog (isolated happy-dom render, same pattern
 * as ProductSpaceSwitcher.interaction.isolated.ts): the D-B interaction
 * contracts — the confirmation checkbox defaults UNCHECKED, the idempotency
 * key is minted only at explicit submit, a lost response offers the receipt
 * query instead of a silent resend, `account_enterprise_exists` routes into
 * the existing project, and a rejected terms version demands a FRESH
 * confirmation instead of a silent replacement — plus the R3 minimal-form
 * contracts (P5/D7): NO standing owner input (the account display name is
 * the automatic owner; the completion field appears only for a blank or
 * over-limit name), an empty purpose is legal end to end, and the local
 * field bounds answer with their specific errors.
 */

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

// P5/D7 owner-name source: the App shell admin user. The holder lets each
// case pick the display name the shell would surface (null = shell without a
// usable display name — the「你的姓名」completion case).
const shellState: { displayName: string | null } = { displayName: null }
mock.module('@/context/AppShellContext', () => ({
  useOptionalAppShellContext: () => ({
    currentAdminUser: shellState.displayName === null
      ? null
      : { userId: 'user-1', username: 'wangxy', displayName: shellState.displayName },
  }),
}))

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

const PERSONAL_ID = 'space-personal'
const EXISTING_ENTERPRISE_ID = 'space-ent-existing'
const CREATED_SPACE_ID = 'space-created'

const personalSpace = {
  id: PERSONAL_ID,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary

const existingEnterprise = {
  id: EXISTING_ENTERPRISE_ID,
  kind: 'enterprise',
  enterpriseId: 'ent-existing',
  name: '已有企业',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-existing' },
} as unknown as ProductSpaceSummary

const createdEnterprise = {
  id: CREATED_SPACE_ID,
  kind: 'enterprise',
  enterpriseId: 'ent-created',
  name: '华东区销售资料库',
  role: 'owner',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-created' },
} as unknown as ProductSpaceSummary

interface CreateHarness {
  createCalls: Array<Record<string, unknown>>
  receiptCalls: Array<Record<string, unknown>>
}

function makeHarness(options: {
  /** One entry per create call: undefined resolves `created`, an object
   * rejects with that code (missing code = transport-level loss). */
  createScript?: Array<{ code?: string } | undefined>
  receiptState?: 'created' | 'unknown'
} = {}): CreateHarness {
  const harness: CreateHarness = { createCalls: [], receiptCalls: [] }
  let createIndex = 0
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmCreateEnterprise: async (input: Record<string, unknown>) => {
        harness.createCalls.push(input)
        const script = options.createScript ?? [undefined]
        const step = script[createIndex++]
        if (step) {
          throw Object.assign(new Error(step.code ?? 'transport lost'), step.code ? { code: step.code } : {})
        }
        return {
          result: 'created',
          enterpriseId: 'ent-created',
          productSpaceId: CREATED_SPACE_ID,
          viewerRole: 'owner',
          enterpriseName: String((input.command as Record<string, unknown>).name),
          createdAt: '2026-11-02T00:00:00.000Z',
        }
      },
      pmQueryCreateReceipt: async (input: Record<string, unknown>) => {
        harness.receiptCalls.push(input)
        return options.receiptState === 'unknown'
          ? { state: 'unknown' }
          : {
              state: 'created',
              enterpriseId: 'ent-created',
              productSpaceId: CREATED_SPACE_ID,
              createdAt: '2026-11-02T00:00:00.000Z',
            }
      },
    },
  })
  return harness
}

function fillAndConfirm() {
  fireEvent.change(screen.getByTestId('create-project-name-input'), { target: { value: '华东区销售资料库' } })
  fireEvent.change(screen.getByTestId('create-project-owner-input'), { target: { value: '李明' } })
  fireEvent.change(screen.getByTestId('create-project-purpose-input'), { target: { value: '集中管理区域销售资料' } })
  fireEvent.click(screen.getByTestId('create-project-responsibility').querySelector('input')!)
}

/** The R3 minimal fill: name + consent only (usable display name → no owner
 * input exists, and the purpose stays EMPTY on purpose). */
function fillMinimalAndConfirm() {
  fireEvent.change(screen.getByTestId('create-project-name-input'), { target: { value: '华东区销售资料库' } })
  fireEvent.click(screen.getByTestId('create-project-responsibility').querySelector('input')!)
}

function submitForm() {
  fireEvent.submit(document.getElementById('create-project-form')!)
}

function renderCreate(options: Parameters<typeof makeHarness>[0] & {
  accountId?: string
  onSelectProductSpace?: (id: string) => void
  onRequestSwitch?: (id: string) => Promise<void>
  onRefreshProductSpaces?: () => Promise<ProductSpaceSummary[] | null>
  onVerifyPhone?: () => void
} = {}) {
  const harness = makeHarness(options)
  const accountId = options.accountId ?? 'account-create-1'
  const onOpenChange = mock(() => {})
  const onSelectProductSpace = options.onSelectProductSpace ?? mock(() => {})
  // R3 D13: the create-success auto-enter rides the project-entry flow, which
  // issues the awaitable switch primitive (not the fire-and-forget select).
  const onRequestSwitch = options.onRequestSwitch ?? mock(() => Promise.resolve())
  const onVerifyPhone = options.onVerifyPhone ?? mock(() => {})
  const onRefreshProductSpaces = options.onRefreshProductSpaces
    ?? (async () => [personalSpace, createdEnterprise])
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
          activeProductSpaceId: PERSONAL_ID,
          activeProductSpace: personalSpace,
          productSpaces: [personalSpace, existingEnterprise],
          allProductSpaces: [personalSpace, existingEnterprise],
          personalProductSpaceId: PERSONAL_ID,
          productSpaceContextKey: JSON.stringify(['product-space', 1, accountId, PERSONAL_ID]),
          contextVersion: 1,
          pendingSwitch: null,
          onSelectProductSpace,
          onRequestSwitch,
          onRefreshProductSpaces,
          onConfirmStopAndSwitch: mock(() => {}),
          onRetryFailedStops: mock(() => {}),
          onRetryTargetLoad: mock(() => {}),
          onCancelSwitch: mock(() => {}),
          onDismissTargetAccessLost: mock(() => {}),
        },
      },
      createElement(Dialog, { open, onOpenChange, onVerifyPhone }),
    ),
  )
  const view = render(buildTree(true))
  return { harness, onOpenChange, onSelectProductSpace, onRequestSwitch, setOpen: (open: boolean) => view.rerender(buildTree(open)) }
}

const checkbox = () => screen.getByTestId('create-project-responsibility').querySelector('input') as HTMLInputElement

beforeEach(async () => {
  shellState.displayName = null
  await i18n.changeLanguage('zh-Hans')
})

afterEach(cleanup)

describe('CreateProjectDialog (POO-196 追加轮 D-B)', () => {
  it('D-B 1: the confirmation defaults UNCHECKED and an unconfirmed submit never reaches the server', async () => {
    const { harness } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    expect(checkbox().checked).toBe(false)
    fillAndConfirm()
    // Undo just the confirmation: everything else is valid.
    fireEvent.click(checkbox())
    submitForm()

    await waitFor(() => expect(screen.getByTestId('create-project-dialog').textContent).toContain('需要先勾选确认'))
    expect(harness.createCalls).toHaveLength(0)
  })

  it('D-B 5/7: the key is minted at explicit submit, the command echoes the contract literal, and "created" switches into the space', async () => {
    const onSelectProductSpace = mock(() => {})
    const { harness, onOpenChange, onRequestSwitch } = renderCreate({ onSelectProductSpace })
    await screen.findByTestId('create-project-dialog')

    // Nothing left the renderer before the explicit submit.
    expect(harness.createCalls).toHaveLength(0)
    fillAndConfirm()
    submitForm()

    await waitFor(() => expect(harness.createCalls).toHaveLength(1))
    const call = harness.createCalls[0]!
    expect(call.idempotencyKey).toMatch(/^pm-create-/)
    expect(call.accountId).toBe('account-create-1')
    expect(call.command).toEqual({
      name: '华东区销售资料库',
      ownerName: '李明',
      purpose: '集中管理区域销售资料',
      paymentResponsibilityAccepted: true,
      paymentResponsibilityTermsVersion: clientEnterpriseCreatePresentation.termsVersion,
    })

    // created ≠ entered: refresh → find → CONTROLLED switch; the auto-enter
    // asks the host to close (and resets the form for the next open).
    await waitFor(() => expect(onRequestSwitch).toHaveBeenCalledWith(CREATED_SPACE_ID))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('D-B 6: a lost response offers the receipt query and never resends; the query reuses the SAME key', async () => {
    const onSelectProductSpace = mock(() => {})
    const { harness, onRequestSwitch } = renderCreate({
      // No `code` = unclassifiable transport failure → unresolved.
      createScript: [{}],
      onSelectProductSpace,
    })
    await screen.findByTestId('create-project-dialog')
    fillAndConfirm()
    submitForm()

    expect(await screen.findByTestId('create-project-recovery')).toBeTruthy()
    expect(harness.createCalls).toHaveLength(1)
    // The stored key keeps the request queryable across the lost response.
    fireEvent.click(screen.getByTestId('create-project-query-receipt'))

    await waitFor(() => expect(harness.receiptCalls).toHaveLength(1))
    expect(harness.receiptCalls[0]!.createRequestKey).toBe(harness.createCalls[0]!.idempotencyKey)

    // The receipt says created → the aggregate lands, still without a resend.
    await waitFor(() => expect(screen.getByTestId('create-project-dialog').getAttribute('data-phase')).toBe('created'))
    await waitFor(() => expect(onRequestSwitch).toHaveBeenCalledWith(CREATED_SPACE_ID))
    expect(harness.createCalls).toHaveLength(1)
  })

  it('D-B 4: account_enterprise_exists routes into the EXISTING project instead of a second enterprise', async () => {
    const onSelectProductSpace = mock(() => {})
    renderCreate({ createScript: [{ code: 'account_enterprise_exists' }], onSelectProductSpace })
    await screen.findByTestId('create-project-dialog')
    fillAndConfirm()
    submitForm()

    expect(await screen.findByTestId('create-project-enterprise-exists')).toBeTruthy()
    expect(screen.getByTestId('create-project-dialog').getAttribute('data-phase')).toBe('form')

    fireEvent.click(screen.getByTestId('create-project-enter-existing'))
    expect(onSelectProductSpace).toHaveBeenCalledWith(EXISTING_ENTERPRISE_ID)
  })

  it('D-B 3: phone_verification_required hands off to the existing verification flow', async () => {
    const onVerifyPhone = mock(() => {})
    const { harness, onRequestSwitch } = renderCreate({
      accountId: 'account-create-phone',
      createScript: [{ code: 'phone_verification_required' }],
      onVerifyPhone,
    })
    await screen.findByTestId('create-project-dialog')
    fillAndConfirm()
    submitForm()
    expect(await screen.findByTestId('create-project-phone-verification')).toBeTruthy()
    fireEvent.click(screen.getByTestId('create-project-verify-phone'))
    expect(onVerifyPhone).toHaveBeenCalledTimes(1)
    expect(harness.createCalls).toHaveLength(1)
  })

  it('D-B 2: a rejected terms version unchecks the box, demands a fresh confirmation, and resubmits under a NEW key', async () => {
    const onSelectProductSpace = mock(() => {})
    const { harness, onRequestSwitch } = renderCreate({ createScript: [{ code: 'validation_error' }, undefined], onSelectProductSpace })
    await screen.findByTestId('create-project-dialog')
    fillAndConfirm()
    submitForm()

    // The server-side rejection reads as a terms mismatch: the acknowledgement
    // is dropped and the mismatch is announced — never silently replaced.
    expect(await screen.findByTestId('create-project-version-mismatch')).toBeTruthy()
    expect(checkbox().checked).toBe(false)

    fireEvent.click(checkbox())
    expect(screen.queryByTestId('create-project-version-mismatch')).toBeNull()
    submitForm()

    await waitFor(() => expect(harness.createCalls).toHaveLength(2))
    expect(harness.createCalls[1]!.idempotencyKey).not.toBe(harness.createCalls[0]!.idempotencyKey)
    // The fresh key lands too: the resubmitted aggregate auto-enters.
    await waitFor(() => expect(onRequestSwitch).toHaveBeenCalledWith(CREATED_SPACE_ID))
  })

  it('when the refreshed list has no such space, the created page STAYS with a retry — never a re-create', async () => {
    const onSelectProductSpace = mock(() => {})
    const { harness, onOpenChange, onRequestSwitch } = renderCreate({
      onSelectProductSpace,
      // The refresh deliberately omits the created space (server lag etc).
      onRefreshProductSpaces: async () => [personalSpace],
    })
    await screen.findByTestId('create-project-dialog')

    fillAndConfirm()
    submitForm()

    const dialog = await screen.findByTestId('create-project-dialog')
    await waitFor(() => expect(dialog.getAttribute('data-phase')).toBe('created'))
    expect(screen.getByTestId('create-project-title').textContent).toContain('项目已创建')
    expect(screen.getByTestId('create-project-retry-enter')).toBeTruthy()
    // No switch happened, and the aggregate was NOT submitted twice.
    expect(onRequestSwitch).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(harness.createCalls).toHaveLength(1)
  })

  it('after the auto-enter closes the dialog, reopening offers a FRESH form, never the stale created page', async () => {
    const onSelectProductSpace = mock(() => {})
    const { harness, onOpenChange, setOpen, onRequestSwitch } = renderCreate({ onSelectProductSpace })
    await screen.findByTestId('create-project-dialog')

    fillAndConfirm()
    submitForm()
    // created → auto-enter succeeds → the dialog asks the host to close.
    await waitFor(() => expect(onRequestSwitch).toHaveBeenCalledWith(CREATED_SPACE_ID))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // The host honours the close (the dialog INSTANCE stays mounted — App
    // pattern), then the entry is used again.
    setOpen(false)
    await waitFor(() => expect(screen.queryByTestId('create-project-dialog')).toBeNull())
    setOpen(true)

    const reopened = await screen.findByTestId('create-project-dialog')
    expect(reopened.getAttribute('data-phase')).toBe('form')
    expect(screen.getByTestId('create-project-title').textContent).not.toContain('项目已创建')
    expect(harness.createCalls).toHaveLength(1)
  })

  it('renders the zh-Hans strings VERBATIM from the generated contract presentation', () => {
    expect(i18n.t('createProject.field.nameLabel')).toBe(clientEnterpriseCreatePresentation.fields.projectName.label)
    expect(i18n.t('createProject.field.nameHint')).toBe(clientEnterpriseCreatePresentation.fields.projectName.hint)
    expect(i18n.t('createProject.description')).toBe(clientEnterpriseCreatePresentation.responsibility.scopeStatement)
    expect(i18n.t('createProject.responsibilityConfirm')).toBe(clientEnterpriseCreatePresentation.responsibility.confirmStatement)
    expect(i18n.t('createProject.responsibilityMismatch')).toBe(clientEnterpriseCreatePresentation.responsibility.versionMismatchHint)
    expect(i18n.t('createProject.budgetFact')).toBe(clientEnterpriseCreatePresentation.budgetFact)
    expect(clientEnterpriseCreatePresentation.responsibility.confirmDefaultChecked).toBe(false)
  })
})

describe('CreateProjectDialog (POO-196 R3 minimal form, P5/D7)', () => {
  it('P5: a usable account display name shows NO owner input; name + empty purpose submit with the display name as owner', async () => {
    shellState.displayName = '李明'
    const onSelectProductSpace = mock(() => {})
    const { harness, onRequestSwitch } = renderCreate({ onSelectProductSpace })
    await screen.findByTestId('create-project-dialog')

    // The standing owner field is GONE for a usable display name.
    expect(screen.queryByTestId('create-project-owner-input')).toBeNull()
    expect(screen.queryByTestId('create-project-owner-sync-hint')).toBeNull()

    // Nothing pre-fills the purpose and nothing derives it from the name.
    expect((screen.getByTestId('create-project-purpose-input') as HTMLTextAreaElement).value).toBe('')
    fillMinimalAndConfirm()
    submitForm()

    await waitFor(() => expect(harness.createCalls).toHaveLength(1))
    const command = harness.createCalls[0]!.command as Record<string, unknown>
    expect(command.ownerName).toBe('李明')
    // D7: the optional purpose crosses the wire as an honest empty string.
    expect(command.purpose).toBe('')
    await waitFor(() => expect(onRequestSwitch).toHaveBeenCalledWith(CREATED_SPACE_ID))
  })

  it('P5/D7: a blank display name surfaces the「你的姓名」completion field with the sync hint; 65 code units do too, 64 do not', async () => {
    // Blank counts as MISSING.
    const blank = renderCreate()
    await screen.findByTestId('create-project-dialog')
    expect(screen.getByTestId('create-project-owner-input')).toBeTruthy()
    expect(screen.getByTestId('create-project-owner-sync-hint').textContent).toBe('用于成员识别，将同步到账号显示名')
    blank.setOpen(false)

    shellState.displayName = 'x'.repeat(65)
    const over = renderCreate()
    await screen.findByTestId('create-project-dialog')
    expect(screen.getByTestId('create-project-owner-input')).toBeTruthy()
    over.setOpen(false)

    shellState.displayName = 'x'.repeat(64)
    const exact = renderCreate()
    await screen.findByTestId('create-project-dialog')
    expect(screen.queryByTestId('create-project-owner-input')).toBeNull()
    exact.setOpen(false)
  })

  it('D7 local bounds: 65-unit owner answer, 129-char name and 513-char purpose each get their specific error and never reach the server', async () => {
    const { harness } = renderCreate()
    await screen.findByTestId('create-project-dialog')

    fireEvent.change(screen.getByTestId('create-project-name-input'), { target: { value: '名'.repeat(129) } })
    fireEvent.change(screen.getByTestId('create-project-owner-input'), { target: { value: '字'.repeat(65) } })
    fireEvent.change(screen.getByTestId('create-project-purpose-input'), { target: { value: '介'.repeat(513) } })
    fireEvent.click(screen.getByTestId('create-project-responsibility').querySelector('input')!)
    submitForm()

    const dialog = screen.getByTestId('create-project-dialog')
    expect(dialog.textContent).toContain('项目名称不能超过 128 个字符')
    expect(dialog.textContent).toContain('姓名不能超过 64 个字符')
    expect(dialog.textContent).toContain('介绍不能超过 512 个字符')
    expect(harness.createCalls).toHaveLength(0)
  })

  it('D7: contract_version_unsupported is a definite failure with the update-prompt copy — the form stays editable', async () => {
    renderCreate({ createScript: [{ code: 'contract_version_unsupported' }] })
    await screen.findByTestId('create-project-dialog')
    fillAndConfirm()
    submitForm()

    expect(await screen.findByTestId('create-project-submit-error')).toBeTruthy()
    expect(screen.getByTestId('create-project-submit-error').textContent)
      .toBe('当前服务尚不支持此创建方式，请更新后重试')
    expect(screen.getByTestId('create-project-dialog').getAttribute('data-phase')).toBe('form')
    expect(screen.getByTestId('create-project-name-input')).toBeTruthy()
  })
})
