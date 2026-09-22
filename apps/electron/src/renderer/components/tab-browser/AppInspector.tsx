import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { StateCard, StatusPill, type StatusPillTone } from '@/components/hifi'

/**
 * App 详情（P-M03-INSPECTOR）。
 *
 * 展示来源/版本/状态原因/权限；「为何阻断」只给恢复路径、不写责任归因
 * （review 内容边界：状态展示而非承诺句式）。
 */

export interface InspectorSource {
  label: string
  /** 来源方署名（圈子创建者等）。 */
  detail?: string
  valid: boolean
}

export interface AppInspectorTarget {
  name: string
  iconUrl?: string
  sources: InspectorSource[]
  version?: string
  statusLabel: string
  statusTone?: StatusPillTone
  statusReason?: string
  /** 阻断时的恢复路径说明（不归因）。 */
  blockedPath?: string
  permissions?: string[]
}

interface AppInspectorProps {
  target: AppInspectorTarget
  onBack: () => void
  onOpen?: () => void
  onViewRuntime?: () => void
}

export function AppInspector({
  target,
  onBack,
  onOpen,
  onViewRuntime,
}: AppInspectorProps) {
  const { t } = useTranslation()
  const facts = [
    {
      label: t('homeApps.inspector.source'),
      value: (
        <span className="flex flex-wrap gap-1.5">
          {target.sources.map(source => (
            <span
              key={source.label}
              className="flex items-center gap-1"
            >
              <StatusPill tone={source.valid ? 'neutral' : 'destructive'}>
                {source.label}
                {source.detail ? ` · ${source.detail}` : ''}
                {!source.valid && ` · ${t('homeApps.inspector.sourceInvalid')}`}
              </StatusPill>
            </span>
          ))}
        </span>
      ),
    },
    {
      label: t('homeApps.inspector.version'),
      value: target.version ?? t('homeApps.inspector.noVersion'),
    },
    {
      label: t('homeApps.inspector.status'),
      value: <StatusPill tone={target.statusTone ?? 'info'}>{target.statusLabel}</StatusPill>,
    },
    ...(target.statusReason
      ? [{
          label: t('homeApps.inspector.statusReason'),
          value: target.statusReason,
        }]
      : []),
  ]

  return (
    <div data-testid="app-inspector" className="flex justify-center py-4">
      <StateCard
        eyebrow={t('homeApps.inspector.title')}
        icon={{ kind: target.blockedPath ? 'destructive' : 'accent' }}
        title={(
          <span className="inline-flex items-center justify-center gap-2">
            {target.iconUrl && (
              <img
                src={target.iconUrl}
                alt=""
                className="size-7 rounded-md object-cover"
              />
            )}
            {target.name}
          </span>
        )}
        facts={facts}
      >
        <div className="mt-[22px] space-y-2 text-left">
          <p className="text-hifi-sm font-medium uppercase tracking-wide text-hifi-fg-50">
            {t('homeApps.inspector.permissions')}
          </p>
          {target.permissions && target.permissions.length > 0 ? (
            <ul className="space-y-1.5">
              {target.permissions.map(permission => (
                <li
                  key={permission}
                  className="flex items-start gap-2 text-hifi-base text-hifi-fg-60"
                >
                  <Icons.ShieldCheck
                    className="mt-0.5 size-4 shrink-0 text-hifi-fg-40"
                    strokeWidth={1.5}
                  />
                  <span>{permission}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-hifi-base text-hifi-fg-60">
              {t('homeApps.install.noPermissions')}
            </p>
          )}
          {target.blockedPath && (
            <p className="mt-3 rounded-hifi-md border border-hifi-border bg-hifi-fg-3 px-3 py-2 text-hifi-base text-hifi-fg-70">
              {target.blockedPath}
            </p>
          )}
        </div>
        <div className="mt-[22px] flex flex-wrap justify-center gap-2">
          {onOpen && (
            <Button type="button" size="sm" onClick={onOpen}>
              {t('homeApps.inspector.open')}
            </Button>
          )}
          {onViewRuntime && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onViewRuntime}
            >
              {t('homeApps.inspector.viewRuntime')}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            {t('homeApps.inspector.close')}
          </Button>
        </div>
      </StateCard>
    </div>
  )
}
