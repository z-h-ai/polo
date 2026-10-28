import React from 'react'
import { Checkbox } from '@polo-ai/ui/ui/checkbox'
import { OptionSelect } from '@polo-ai/ui/ui/option-select'
import { WorkbenchSelect } from '@/components/ui/workbench-controls'
import type { ComponentEntry } from './types'
import {
  SettingsSection,
  SettingsGroup,
  SettingsDivider,
  SettingsCard,
  SettingsCardContent,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsRadioGroup,
  SettingsRadioCard,
  SettingsRadioOption,
  SettingsSegmentedControl,
  SettingsSegmentedControlCard,
  SettingsSelect,
  SettingsSelectRow,
  SettingsMenuSelect,
  SettingsInput,
  SettingsInputRow,
  SettingsSecretInput,
  SettingsTextarea,
} from '@/components/settings'

// Interactive wrappers keep the real controlled components stateful so the
// preview behaves like the production settings pages instead of static props.
function ToggleDemo(props: { disabled?: boolean; description?: string }) {
  const [checked, setChecked] = React.useState(true)
  return (
    <SettingsToggle
      label="同步会话历史"
      description="关闭后新会话仅保存在本机"
      checked={checked}
      onCheckedChange={setChecked}
      {...props}
    />
  )
}

const selectOptions = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function SelectDemo(props: { disabled?: boolean; inCard?: boolean }) {
  const [value, setValue] = React.useState('auto')
  return (
    <SettingsSelect
      label="外观"
      description="选择界面配色主题"
      value={value}
      onValueChange={setValue}
      options={selectOptions}
      {...props}
    />
  )
}

const menuOptions = [
  { value: 'balanced', label: '平衡', description: '默认响应速度与质量' },
  { value: 'quality', label: '质量优先', description: '更慢但更完整' },
  { value: 'speed', label: '速度优先', description: '最快返回首字' },
]

function SegmentedDemo(props: { size?: 'sm' | 'md' }) {
  const [value, setValue] = React.useState('balanced')
  return (
    <SettingsSegmentedControl
      value={value}
      onValueChange={setValue}
      options={menuOptions.map(({ value: v, label }) => ({ value: v, label }))}
      {...props}
    />
  )
}

function SegmentedCardDemo() {
  const [value, setValue] = React.useState('balanced')
  return (
    <SettingsSegmentedControlCard
      value={value}
      onValueChange={setValue}
      columns={3}
      options={menuOptions.map(({ value: v, label }) => ({ value: v, label }))}
    />
  )
}

function RadioGroupDemo() {
  const [value, setValue] = React.useState('cloud')
  return (
    <SettingsRadioGroup value={value} onValueChange={setValue}>
      <SettingsRadioCard
        value="cloud"
        label="云端模型"
        description="由平台托管，开箱即用"
        badge="推荐"
        expandedContent={<SettingsSecretInput label="API Key" value="sk-..." onChange={() => {}} />}
      />
      <SettingsRadioCard value="local" label="本地模型" description="数据不出本机，需要自行部署" />
      <SettingsRadioCard value="custom" label="自定义接入" description="填写兼容 OpenAI 协议的端点" />
    </SettingsRadioGroup>
  )
}

function MenuSelectDemo() {
  const [value, setValue] = React.useState('balanced')
  return (
    <SettingsMenuSelect value={value} onValueChange={setValue} options={menuOptions} placeholder="选择推理偏好" />
  )
}

function InputDemo(props: { type?: 'text' | 'password' | 'email' | 'url'; error?: string }) {
  const [value, setValue] = React.useState('https://api.example.com/v1')
  return (
    <SettingsInput
      label="接口地址"
      description="兼容 OpenAI 协议的完整端点"
      value={value}
      onChange={setValue}
      {...props}
    />
  )
}

function SecretInputDemo(props: { error?: string }) {
  const [value, setValue] = React.useState('sk-demo-1234567890')
  return <SettingsSecretInput label="API Key" value={value} onChange={setValue} {...props} />
}

function TextareaDemo() {
  const [value, setValue] = React.useState('你是一个严谨的助手。')
  return (
    <SettingsTextarea
      label="系统提示词"
      description="追加到每个会话开头"
      value={value}
      onChange={setValue}
      maxLength={200}
    />
  )
}

// Full-page assembly mirrors pages/settings/*: Section → Card(divided) → rows,
// plus the danger variant and a card footer for destructive actions.
function PageDemo() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 p-8">
      <SettingsSection title="通用" description="影响全局的基础行为">
        <SettingsCard divided>
          <ToggleDemo />
          <SettingsDivider />
          <SelectDemo inCard />
          <SettingsDivider />
          <SettingsRow label="检查更新" description="自动下载并提示安装" inCard>
            <SegmentedDemo size="sm" />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="推理偏好">
        <SettingsGroup title="偏好">
          <SegmentedCardDemo />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="模型接入" variant="default">
        <SettingsCard divided>
          <RadioGroupDemo />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="危险操作" variant="danger">
        <SettingsCard>
          <SettingsCardContent>
            <SettingsRow label="清除全部本地数据" description="删除会话历史、凭据缓存与工作区索引" inCard />
          </SettingsCardContent>
          <SettingsCardFooter>
            <button className="text-destructive text-sm font-medium">清除数据</button>
          </SettingsCardFooter>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}


function UnifiedSelectDemo({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = React.useState('all')
  const [checked, setChecked] = React.useState(true)
  const options = [
    { value: 'all', label: '全部来源' },
    { value: 'circle', label: '设计圈子' },
    { value: 'long', label: '名称较长的团队空间与应用来源' },
  ]
  return <div className="grid w-full max-w-sm gap-4">
    <label className="flex items-center gap-2"><Checkbox checked={checked} onChange={event => setChecked(event.target.checked)} disabled={disabled} />保留应用数据</label>
    <label className="grid gap-2">工作台筛选
      <WorkbenchSelect aria-label="工作台筛选" value={value} onValueChange={setValue} options={options} disabled={disabled} />
    </label>
    <label className="grid gap-2">设置与助手表单
      <OptionSelect aria-label="设置与助手表单" value={value} onValueChange={setValue} options={options} disabled={disabled} />
    </label>
  </div>
}

export const settingsComponents: ComponentEntry[] = [
  {
    id: 'settings-unified-controls',
    name: 'OptionSelect / WorkbenchSelect / Checkbox',
    category: 'Settings',
    description: 'Shared selection with renderer and workbench token scopes; real controlled values',
    component: UnifiedSelectDemo,
    layout: 'top',
    props: [{ name: 'disabled', control: { type: 'boolean' }, defaultValue: false }],
    variants: [{ name: 'Enabled', props: {} }, { name: 'Disabled', props: { disabled: true } }],
  },
  {
    id: 'settings-page-preview',
    name: 'Settings Page Assembly',
    category: 'Settings',
    description: 'Full settings page assembly: Section + divided Card + rows + danger section + footer',
    component: PageDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'settings-section',
    name: 'SettingsSection',
    category: 'Settings',
    description: 'Titled group container; variant danger for destructive groups, optional header action',
    component: ({ variant = 'default' }) => (
      <SettingsSection title="通用" description="影响全局的基础行为" variant={variant}>
        <SettingsCard divided>
          <ToggleDemo />
        </SettingsCard>
      </SettingsSection>
    ),
    layout: 'top',
    props: [{
      name: 'variant',
      control: { type: 'select', options: [{ label: 'default', value: 'default' }, { label: 'danger', value: 'danger' }] },
      defaultValue: 'default',
    }],
  },
  {
    id: 'settings-toggle',
    name: 'SettingsToggle',
    category: 'Settings',
    description: 'Switch row with label/description; inCard affects padding',
    component: ToggleDemo,
    layout: 'top',
    props: [
      { name: 'disabled', control: { type: 'boolean' }, defaultValue: false },
      { name: 'description', control: { type: 'string' }, defaultValue: '关闭后新会话仅保存在本机' },
    ],
    variants: [
      { name: 'Checked', props: {} },
      { name: 'Disabled', props: { disabled: true } },
    ],
  },
  {
    id: 'settings-select',
    name: 'SettingsSelect / SettingsSelectRow',
    category: 'Settings',
    description: 'Styled select as standalone field or row wrapper',
    component: ({ row = false, disabled = false }: { row?: boolean; disabled?: boolean }) =>
      row ? (
        <SettingsSelectRow
          label="外观"
          description="选择界面配色主题"
          value="auto"
          onValueChange={() => {}}
          options={selectOptions}
          disabled={disabled}
        />
      ) : (
        <SelectDemo disabled={disabled} />
      ),
    layout: 'top',
    props: [
      { name: 'row', control: { type: 'boolean' }, defaultValue: false },
      { name: 'disabled', control: { type: 'boolean' }, defaultValue: false },
    ],
  },
  {
    id: 'settings-menu-select',
    name: 'SettingsMenuSelect',
    category: 'Settings',
    description: 'Dropdown select with descriptions and auto-search past 8 options',
    component: MenuSelectDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'settings-segmented-control',
    name: 'SettingsSegmentedControl',
    category: 'Settings',
    description: 'Horizontal segmented button group, sm/md sizes',
    component: SegmentedDemo,
    layout: 'top',
    props: [{
      name: 'size',
      control: { type: 'select', options: [{ label: 'sm', value: 'sm' }, { label: 'md', value: 'md' }] },
      defaultValue: 'md',
    }],
  },
  {
    id: 'settings-segmented-card',
    name: 'SettingsSegmentedControlCard',
    category: 'Settings',
    description: 'Card-style segmented grid with 2-4 columns',
    component: SegmentedCardDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'settings-radio-group',
    name: 'SettingsRadioGroup / RadioCard',
    category: 'Settings',
    description: 'Radio cards with badge and selected expandedContent',
    component: RadioGroupDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'settings-input',
    name: 'SettingsInput / SettingsInputRow',
    category: 'Settings',
    description: 'Text field with optional error; row variant pairs label + field',
    component: InputDemo,
    layout: 'top',
    props: [
      {
        name: 'type',
        control: {
          type: 'select',
          options: ['text', 'password', 'email', 'url'].map(value => ({ label: value, value })),
        },
        defaultValue: 'url',
      },
      { name: 'error', control: { type: 'string' }, defaultValue: '' },
    ],
    variants: [
      { name: 'Default', props: {} },
      { name: 'Error', props: { error: '地址必须以 https:// 开头' } },
    ],
  },
  {
    id: 'settings-secret-input',
    name: 'SettingsSecretInput',
    category: 'Settings',
    description: 'Secret field with show/hide toggle',
    component: SecretInputDemo,
    layout: 'top',
    props: [{ name: 'error', control: { type: 'string' }, defaultValue: '' }],
  },
  {
    id: 'settings-textarea',
    name: 'SettingsTextarea',
    category: 'Settings',
    description: 'Textarea with character count against maxLength',
    component: TextareaDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'settings-row-divider-group',
    name: 'SettingsRow + Divider + Group',
    category: 'Settings',
    description: 'Row primitives: action button, click row, SettingsGroup and SettingsDivider',
    component: () => (
      <div className="space-y-6 p-8">
        <SettingsGroup title="账号">
          <SettingsRow label="账号与安全" description="密码、设备与登录方式" onClick={() => {}} />
          <SettingsDivider />
          <SettingsRow label="当前版本" description="Polo AI 1.0.0" action={<button className="text-sm">检查更新</button>} />
        </SettingsGroup>
      </div>
    ),
    layout: 'top',
    props: [],
  },
]
