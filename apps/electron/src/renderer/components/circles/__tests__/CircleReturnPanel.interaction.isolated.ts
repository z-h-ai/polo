import { describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { setupI18n } from '@polo-ai/shared/i18n'
import type { OriginalCircleOrder } from '@polo-ai/shared/admin'
import type { CircleReturnState } from '@/hooks/useCircleReturn'

GlobalRegistrator.register()
setupI18n()
const testI18n = setupI18n()

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-Hans' },
  }),
}))
const { CircleReturnPanel } = await import('../CircleReturnPanel')

const order: OriginalCircleOrder = {
  orderId: 'order-29900',
  storedStatus: 'paid',
  amountMinor: 29900,
  currency: 'CNY',
  checkoutUrl: null,
  periodEndAt: '2026-11-01T00:00:00.000Z',
  circle: {
    circleId: 'c8c8c8c8-0000-4000-8000-00000000c805',
    name: '金额格式圈',
  },
  paymentOwner: 'B01',
}

const state: CircleReturnState = {
  phase: 'verified',
  target: {
    orderId: 'order-29900',
    circleId: order.circle.circleId,
  },
  candidateId: 'candidate-currency',
  kind: 'order',
  orderFacts: {
    order,
    storedStatusIsHistoryOnly: true,
    checkout: null,
    checkoutUnknown: true,
  },
  entitlement: 'unknown',
  failure: null,
  checking: false,
  scopeKey: 'scope',
}

describe('CircleReturnPanel currency display', () => {
  it('renders minor-unit order amounts through the shared subscription formatter', () => {
    const { container } = render(
      createElement(
        CircleReturnPanel,
        {
          state,
          onCheck: () => {},
          onCancel: () => {},
          targetCircleName: order.circle.name,
          spaceName: '我的空间',
        },
      ),
    )

    const amount = container.querySelector('[data-testid="circle-return-order-amount"]')!
    expect(amount.textContent).toContain('299.00')
    expect(amount.textContent).not.toContain('29900')
  })
})
