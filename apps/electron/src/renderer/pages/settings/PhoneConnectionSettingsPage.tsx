/**
 * PhoneConnectionSettingsPage — 设置页「手机连接」（PRD v1.6 §⑤，原型帧 D02/P12）
 *
 * 三块（+ 折叠）：①配对新手机（pairing-code → QRCodeSVG 渲染 {code, wsUrl}
 * JSON + 5min 倒计时 + 重新生成）；②连接状态（M1-5 状态事件尚未接入，
 * 默认离线态）；③已绑手机列表（N/5，逐台撤销 → Radix 二次确认，解绑即时
 * 受理最长 60s 断开）；④高级信息折叠（macDeviceId / LAN wsUrl，默认收起）。
 *
 * 数据链：preload phone-link API → LOCAL_ONLY RPC（main/handlers/phone-link.ts）
 * → AdminClient → polo-admin /api/devices/*。纯逻辑（倒计时/列表映射/QR payload）
 * 在 shared/phone-link.ts，由 bun test 覆盖。
 */

import * as React from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCcw,
  Smartphone,
} from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@polo-ai/ui'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { SettingsSection, SettingsCard, SettingsRow } from '@/components/settings'
import {
  buildPairingQrPayload,
  formatCountdown,
  getPhoneLinkApi,
  lastSeenBucket,
  mapDeviceListState,
  pairingCountdownState,
  MAX_PHONES_PER_MAC,
  type PhoneDeviceView,
  type PhoneLinkHostInfo,
  type PhoneLinkRelayStatus,
  type PhonePairingCodeResult,
} from '../../../shared/phone-link'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'phone-connection',
}

export default function PhoneConnectionSettingsPage() {
  const { t } = useTranslation()
  // 本机信息（macDeviceId / LAN wsUrl）一次拉取，配对二维码与高级信息共用
  const [hostInfo, setHostInfo] = React.useState<PhoneLinkHostInfo | null>(null)

  React.useEffect(() => {
    let cancelled = false
    getPhoneLinkApi().phoneLinkGetHostInfo()
      .then(info => { if (!cancelled) setHostInfo(info) })
      .catch(() => { if (!cancelled) setHostInfo(null) })
    return () => { cancelled = true }
  }, [])

  return (
    <div data-testid="phone-connection-settings-page" className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.phoneConnection.title')}
        actions={<HeaderMenu route={routes.view.settings('phone-connection')} />}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl space-y-6 px-5 py-7">
            <ConnectionStatusSection />
            <PairingSection hostInfo={hostInfo} />
            <BoundDevicesSection />
            <AdvancedInfoSection hostInfo={hostInfo} />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ① 连接状态（D02：已就绪 · 支持同一 Wi-Fi 直连与外网云中转）
// 消费 M1-5/POL-237 的 relay:statusChanged 广播；首个事件到来前渲染默认离线态。
// ---------------------------------------------------------------------------

function ConnectionStatusSection() {
  const { t } = useTranslation()
  const [relayStatus, setRelayStatus] = React.useState<PhoneLinkRelayStatus | null>(null)

  React.useEffect(() => {
    const off = getPhoneLinkApi().phoneLinkOnRelayStatus(payload => {
      setRelayStatus(payload?.status ?? null)
    })
    return off
  }, [])

  const ready = relayStatus === 'online-relay' || relayStatus === 'online-lan'

  return (
    <SettingsSection title={t('settings.phoneConnection.status.title')}>
      <SettingsCard>
        <div className="flex items-center gap-3 px-4 py-3.5">
          {ready ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-foreground/25" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {ready
                ? t('settings.phoneConnection.status.ready')
                : t('settings.phoneConnection.status.notReady')}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.phoneConnection.status.hint')}
            </div>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ---------------------------------------------------------------------------
// ② 配对新手机（pairing-code → 二维码 + 5min 倒计时 + 重新生成）
// ---------------------------------------------------------------------------

type PairingPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: PhonePairingCodeResult }

function PairingSection({ hostInfo }: { hostInfo: PhoneLinkHostInfo | null }) {
  const { t } = useTranslation()
  const [phase, setPhase] = React.useState<PairingPhase>({ kind: 'loading' })
  const [regenerating, setRegenerating] = React.useState(false)
  // 1s 心跳：仅在有活跃配对码时驱动倒计时重渲染
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (phase.kind !== 'ready') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [phase.kind])

  const issueCode = React.useCallback(async (isRegenerate: boolean) => {
    if (isRegenerate) {
      setRegenerating(true)
    } else {
      setPhase({ kind: 'loading' })
    }
    try {
      const result = await getPhoneLinkApi().phoneDeviceCreatePairingCode()
      setNow(Date.now())
      setPhase({ kind: 'ready', result })
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : t('settings.phoneConnection.pairing.failed'),
      })
    } finally {
      setRegenerating(false)
    }
  }, [t])

  React.useEffect(() => {
    void issueCode(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const countdown = phase.kind === 'ready'
    ? pairingCountdownState(phase.result.expiresAt, now)
    : null

  return (
    <SettingsSection
      title={t('settings.phoneConnection.pairing.title')}
      description={t('settings.phoneConnection.pairing.oneTimeHint')}
    >
      <SettingsCard>
        <div className="flex flex-col items-center gap-3 px-4 py-6">
          {phase.kind === 'loading' && (
            <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner className="text-[16px]" />
              {t('settings.phoneConnection.pairing.generating')}
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="flex w-full flex-col items-center gap-3 py-6">
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {phase.message}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={regenerating}
                onClick={() => void issueCode(true)}
              >
                {regenerating
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCcw className="h-3.5 w-3.5" />}
                {t('settings.phoneConnection.pairing.retry')}
              </Button>
            </div>
          )}

          {phase.kind === 'ready' && countdown && (
            <>
              <div className={countdown.kind === 'expired' ? 'opacity-40' : undefined}>
                <div className="rounded-lg bg-white p-4">
                  <QRCodeSVG
                    value={buildPairingQrPayload(phase.result.code, hostInfo?.wsUrl)}
                    size={240}
                    level="M"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm" data-testid="pairing-countdown">
                {countdown.kind === 'active' ? (
                  <>
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium tabular-nums">
                      {t('settings.phoneConnection.pairing.expiresIn', {
                        duration: formatCountdown(countdown.remainingMs),
                      })}
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-destructive">
                    {t('settings.phoneConnection.pairing.expired')}
                  </span>
                )}
              </div>

              <div className="text-xs text-muted-foreground">
                {t('settings.phoneConnection.pairing.scanHint')}
              </div>

              <Button
                variant="outline"
                size="sm"
                disabled={regenerating}
                onClick={() => void issueCode(true)}
              >
                {regenerating
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCcw className="h-3.5 w-3.5" />}
                {t('settings.phoneConnection.pairing.regenerate')}
              </Button>
            </>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

// ---------------------------------------------------------------------------
// ③ 已绑手机列表（N/5 + 逐台撤销 → 二次确认）
// ---------------------------------------------------------------------------

function BoundDevicesSection() {
  const { t } = useTranslation()
  const [state, setState] = React.useState<{
    loading: boolean
    error: string | null
    devices: PhoneDeviceView[]
  }>({ loading: true, error: null, devices: [] })
  const [revokeTarget, setRevokeTarget] = React.useState<PhoneDeviceView | null>(null)
  const [revoking, setRevoking] = React.useState(false)

  const loadDevices = React.useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const result = await getPhoneLinkApi().phoneDeviceList()
      setState({ loading: false, error: null, devices: result.devices })
    } catch (err) {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : t('settings.phoneConnection.devices.loadFailed'),
        devices: [],
      })
    }
  }, [t])

  React.useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  const list = mapDeviceListState(state.devices)

  const confirmRevoke = async () => {
    if (!revokeTarget || revoking) return
    setRevoking(true)
    try {
      await getPhoneLinkApi().phoneDeviceRevoke(revokeTarget.id)
      toast.success(t('settings.phoneConnection.revoke.success'))
      setRevokeTarget(null)
      // 事实源是 admin Device 表 —— 撤销受理后重拉列表
      void loadDevices()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('settings.phoneConnection.revoke.failed'),
      )
    } finally {
      setRevoking(false)
    }
  }

  return (
    <SettingsSection title={t('settings.phoneConnection.devices.title', {
      count: list.count,
      max: MAX_PHONES_PER_MAC,
    })}>
      <SettingsCard>
        {state.loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Spinner className="text-[16px]" />
            {t('settings.phoneConnection.devices.loading')}
          </div>
        ) : state.error ? (
          <div className="flex items-center justify-between gap-3 px-4 py-4">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {state.error}
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadDevices()}>
              <RefreshCcw className="h-3.5 w-3.5" />
              {t('settings.phoneConnection.devices.retry')}
            </Button>
          </div>
        ) : list.devices.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <Smartphone className="h-5 w-5 text-muted-foreground" />
            <div className="text-sm font-medium">
              {t('settings.phoneConnection.devices.emptyTitle')}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('settings.phoneConnection.devices.emptyHint')}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {list.devices.map(device => (
              <DeviceRow
                key={device.id}
                device={device}
                onRevoke={() => setRevokeTarget(device)}
              />
            ))}
          </div>
        )}
        {list.atCapacity && (
          <div className="border-t border-border/50 bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
            {t('settings.phoneConnection.devices.capacityHint', { max: MAX_PHONES_PER_MAC })}
          </div>
        )}
      </SettingsCard>

      <RevokeConfirmDialog
        device={revokeTarget}
        confirming={revoking}
        onOpenChange={open => { if (!open) setRevokeTarget(null) }}
        onConfirm={() => void confirmRevoke()}
      />
    </SettingsSection>
  )
}

function DeviceRow({ device, onRevoke }: { device: PhoneDeviceView; onRevoke: () => void }) {
  const { t } = useTranslation()
  const bucket = lastSeenBucket(device.lastSeenAt, Date.now())
  const lastSeenKey = `settings.phoneConnection.lastSeen.${bucket.key}` as const
  const lastSeen = bucket.key === 'never'
    ? t(lastSeenKey)
    : t(lastSeenKey, { count: 'count' in bucket ? bucket.count : 0 })

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{device.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {t(`settings.phoneConnection.platform.${device.platform}`)}
          {' · '}
          {t('settings.phoneConnection.devices.lastActive')}
          {' '}
          {lastSeen}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={onRevoke}
      >
        {t('settings.phoneConnection.revoke.button')}
      </Button>
    </div>
  )
}

/** P12 二次确认弹层：解绑即时受理，最长 60 秒内全网断开 */
function RevokeConfirmDialog({
  device,
  confirming,
  onOpenChange,
  onConfirm,
}: {
  device: PhoneDeviceView | null
  confirming: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={!!device} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {t('settings.phoneConnection.revoke.title', {
              name: device?.name ?? '',
            })}
          </DialogTitle>
          <DialogDescription>{t('settings.phoneConnection.revoke.body')}</DialogDescription>
        </DialogHeader>
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('settings.phoneConnection.revoke.note')}
        </p>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={() => onOpenChange(false)}>
            {t('settings.phoneConnection.revoke.cancel')}
          </Button>
          <Button variant="destructive" disabled={confirming} onClick={onConfirm}>
            {confirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirming
              ? t('settings.phoneConnection.revoke.confirming')
              : t('settings.phoneConnection.revoke.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// ④ 高级信息（供技术支持排查用；默认收起）
// ---------------------------------------------------------------------------

function AdvancedInfoSection({ hostInfo }: { hostInfo: PhoneLinkHostInfo | null }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  return (
    <SettingsCard divided={false}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-testid="phone-connection-advanced-toggle"
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/70"
      >
        <span className="text-sm font-medium">{t('settings.phoneConnection.advanced.title')}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('settings.phoneConnection.advanced.hint')}
          {open
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/50">
          <SettingsRow
            label={t('settings.phoneConnection.advanced.macDeviceId')}
            description={hostInfo?.macDeviceId ?? '—'}
          />
          <SettingsRow
            label={t('settings.phoneConnection.advanced.wsUrl')}
            description={hostInfo?.wsUrl ?? t('settings.phoneConnection.advanced.notAvailable')}
          />
        </div>
      )}
    </SettingsCard>
  )
}
