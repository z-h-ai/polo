/**
 * Playground registry entry for ProductSpaceSelectScreen (POO-124).
 *
 * Previews the login-time space confirmation gate without a real account:
 * - returning: stored last-used space is the default target
 * - first-login: no local memory → active enterprise is recommended, pinned and preselected
 * - memory-invalid: the stored space became restricted → recommendation moves, copy explains why
 *
 * The restricted note appears once the read-only row is selected (click it in the preview).
 */

import type { ReactNode } from 'react'
import { useClientMaterialScope } from '@/components/ui/client-workbench'
import { ProductSpaceSelectScreen } from '@/components/product-space/ProductSpaceSelectScreen'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { ComponentEntry } from './types'

// The select screen's selected row uses the POO-105 light material; the
// playground shell does not publish the scope, so the demo publishes it.
function MaterialScope({ children }: { children: ReactNode }) {
  useClientMaterialScope()
  return <>{children}</>
}

const personalSpace = {
  id: 'space-personal',
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary

const starMedia = {
  id: 'space-star',
  kind: 'enterprise',
  enterpriseId: 'enterprise-1',
  name: '星辰传媒',
  role: 'owner',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-1' },
} as unknown as ProductSpaceSummary

const blueLake = {
  id: 'space-bluelake',
  kind: 'enterprise',
  enterpriseId: 'enterprise-2',
  name: '蓝湖设计',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-2' },
} as unknown as ProductSpaceSummary

const hengyue = {
  id: 'space-hengyue',
  kind: 'enterprise',
  enterpriseId: 'enterprise-3',
  name: '恒岳法务',
  role: 'member',
  accessMode: 'read_only',
  restrictionCode: 'billing_restricted',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-3' },
} as unknown as ProductSpaceSummary

export const productSpaceSelectComponents: ComponentEntry[] = [
  {
    id: 'product-space-select',
    name: 'Product Space Select',
    category: 'Onboarding',
    description: 'POO-124 登录后空间选择门禁屏（方案 A：520px 居中卡）',
    component: ProductSpaceSelectScreen,
    layout: 'full',
    props: [
      {
        name: 'selectionSource',
        description: 'bootstrap 提交默认目标的方式（决定默认选中与副文案）',
        control: {
          type: 'select',
          options: [
            { label: 'stored（上次使用）', value: 'stored' },
            { label: 'fresh（首登无记忆）', value: 'fresh' },
            { label: 'memory-invalid（记忆失效）', value: 'memory-invalid' },
          ],
        },
        defaultValue: 'stored',
      },
      { name: 'submitting', description: '切换事务进行中（CTA 禁用）', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      { name: '回访 · 默认上次空间', props: { selectionSource: 'stored' } },
      { name: '首登 · 推荐企业置顶', props: { selectionSource: 'fresh' } },
      { name: '记忆失效 · 改推荐', props: { selectionSource: 'memory-invalid' } },
    ],
    mockData: () => ({
      spaces: [personalSpace, starMedia, blueLake, hengyue],
      activeProductSpaceId: 'space-star',
      account: { displayName: '王晓蕴', username: 'wangxy@starmedia.cn' },
      onConfirm: (spaceId: string) => console.log('[product-space-select] confirm', spaceId),
      onLogout: () => console.log('[product-space-select] logout'),
    }),
    wrapper: MaterialScope,
  },
]
