// P04 配对确认屏 (POL-16) — three states in one file per the prototype frame:
//   确认态: target Mac info card + 「配对码剩余 m:ss」 countdown chip + the
//           binding-scope copy; 确认绑定 triggers the admin bind (atomic
//           code redemption — admin is the only source of binding truth).
//   成功态: nav title = the bound Mac's macName (可空，回退 添加电脑) +
//           「绑定成功」 + 去发消息 (session placeholder, P04) + 返回设备列表.
//   错误态: device_bind_limit_reached (P04 第 3 屏) — 该电脑已绑定 5 台手机,
//           with 前往设备管理 as the primary action.
// The countdown is informational (see pairingUi.ts): admin bind is the
// authority; when it hits 0 the chip disappears and the confirm copy nudges
// a re-scan. The bind response's macName (可空) names the success page; the
// confirm frame copy still addresses 「这台电脑」 (no name before binding).

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TabIcon } from '../../components/TabIcons';
import { bindLimitCopy, pairingCountdownCopy, remainingSeconds } from '../../lib/pairingUi';
import { colors, fontSize, radius } from '../../theme/tokens';

export interface PairConfirmData {
  code: string;
  /** LAN hint from the D02 payload; shown in the info card when present. */
  wsUrl: string | null;
  /** Countdown deadline (phone-observed; pairingUi.pairingCodeDeadline). */
  deadlineMs: number;
  /** Ticks the countdown; injectable clock for previews. */
  nowMs: number;
}

export function PairConfirmScreen({
  data,
  busy,
  onConfirm,
  onCancel,
}: {
  data: PairConfirmData;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(data.nowMs);

  useEffect(() => {
    setNow(data.nowMs);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data.nowMs, data.deadlineMs]);

  const countdown = pairingCountdownCopy(remainingSeconds(data.deadlineMs, now));

  return (
    <View style={styles.screen}>
      <View style={styles.navBar}>
        <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={12}>
          <Text style={styles.back}>取消</Text>
        </Pressable>
        <Text style={styles.title}>确认绑定</Text>
        <View style={styles.navSpacer} />
      </View>
      <View style={styles.body}>
        <View style={styles.hero}>
          <View style={styles.heroGlyph}>
            <TabIcon name="devices" color={colors.accentDeep} size={30} />
          </View>
          <Text style={styles.heroTitle}>新的 Polo 电脑</Text>
          {countdown ? (
            <View style={styles.countdownChip}>
              <Text style={styles.countdownText}>⏱ {countdown}</Text>
            </View>
          ) : (
            <Text style={styles.expiredHint}>配对码可能已过期，建议回上一屏重新扫码</Text>
          )}
        </View>
        <View style={styles.card}>
          <InfoRow label="配对码" value={data.code} mono />
          {data.wsUrl ? <InfoRow label="局域网" value={data.wsUrl} mono /> : null}
          <InfoRow label="授权方式" value="配对码经 Polo 云端校验后绑定" />
        </View>
        <Text style={styles.scope}>
          绑定后，本手机可向该 Mac 发送消息并派发任务；每台 Mac 最多绑定 5 台手机，可在「设备管理」中随时解绑。
        </Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onConfirm}
            style={({ pressed }) => [styles.primary, (busy || pressed) && styles.dim]}
          >
            <Text style={styles.primaryLabel}>{busy ? '绑定中…' : '确认绑定'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCancel}
            style={({ pressed }) => [styles.ghost, (busy || pressed) && styles.dim]}
          >
            <Text style={styles.ghostLabel}>取消</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowMono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** P04 第 2 屏：绑定成功反馈（nav title 用 bind 响应的 macName，可空回退）. */
export function PairSuccessScreen({
  reused,
  macName,
  onGoMessages,
  onBackToList,
}: {
  /** reused=true: the same phone re-paired with the same Mac (复用契约). */
  reused: boolean;
  /** Bound Mac's 备注名 — blank/null falls back to the 添加电脑 title. */
  macName: string | null;
  onGoMessages: () => void;
  onBackToList: () => void;
}) {
  const trimmedMacName = typeof macName === 'string' ? macName.trim() : '';
  return (
    <View style={styles.screen}>
      <View style={styles.navBar}>
        <View style={styles.back} />
        <Text style={styles.title}>{trimmedMacName || '添加电脑'}</Text>
        <View style={styles.navSpacer} />
      </View>
      <View style={[styles.body, styles.centerBody]}>
        <View style={styles.successGlyph}>
          <Text style={styles.successCheck}>✓</Text>
        </View>
        <Text style={styles.resultTitle}>绑定成功</Text>
        <Text style={styles.resultMessage}>
          {reused
            ? '本手机与这台电脑的绑定已刷新，\n现在可以从手机向它发送消息了。'
            : '新电脑已加入你的设备列表，\n现在可以从手机向它发送消息了。'}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onGoMessages}
          style={({ pressed }) => [styles.primary, styles.wide, pressed && styles.dim]}
        >
          <Text style={styles.primaryLabel}>去发消息</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onBackToList} hitSlop={8}>
          <Text style={styles.linkText}>返回设备列表</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** P04 第 3 屏：绑定上限整屏错误态（copy single-sourced in pairingUi）. */
export function PairLimitScreen({
  onOpenManage,
  onBack,
}: {
  onOpenManage: () => void;
  onBack: () => void;
}) {
  const copy = bindLimitCopy();
  return (
    <View style={styles.screen}>
      <View style={styles.navBar}>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title}>确认绑定</Text>
        <View style={styles.navSpacer} />
      </View>
      <View style={[styles.body, styles.centerBody]}>
        <View style={styles.limitGlyph}>
          <Text style={styles.limitMark}>!</Text>
        </View>
        <Text style={styles.resultTitle}>{copy.title}</Text>
        <Text style={styles.resultMessage}>{copy.message}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenManage}
          style={({ pressed }) => [styles.primary, styles.wide, pressed && styles.dim]}
        >
          <Text style={styles.primaryLabel}>{copy.action}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8}>
          <Text style={styles.linkText}>{copy.back}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: {
    width: 64,
    color: colors.foreground,
    fontSize: 13.5,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.foreground,
    fontSize: 15,
    fontWeight: '600',
  },
  navSpacer: {
    width: 64,
  },
  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 16,
  },
  centerBody: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  hero: {
    alignItems: 'center',
    gap: 10,
  },
  heroGlyph: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.foreground,
  },
  countdownChip: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownText: {
    fontSize: 12,
    color: colors.accentDeep,
  },
  expiredHint: {
    fontSize: 12,
    color: colors.info,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.field,
    paddingVertical: 4,
    paddingHorizontal: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: 10,
  },
  rowLabel: {
    width: 72,
    fontSize: 12.5,
    color: colors.fg50,
  },
  rowValue: {
    flex: 1,
    fontSize: 13,
    color: colors.foreground,
  },
  rowMono: {
    fontSize: 12.5,
    fontVariant: ['tabular-nums'],
  },
  scope: {
    fontSize: 11.5,
    lineHeight: 19,
    color: colors.fg50,
    paddingHorizontal: 4,
  },
  actions: {
    marginTop: 'auto',
    gap: 10,
    paddingBottom: 26,
  },
  primary: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  ghostLabel: {
    color: colors.foreground,
    fontSize: fontSize.button,
    fontWeight: '500',
  },
  wide: {
    alignSelf: 'stretch',
    marginTop: 12,
  },
  dim: {
    opacity: 0.7,
  },
  linkText: {
    color: colors.accent,
    fontSize: 13,
    marginTop: 2,
  },
  successGlyph: {
    width: 72,
    height: 72,
    borderRadius: 99,
    backgroundColor: 'rgba(9,137,38,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successCheck: {
    color: colors.success,
    fontSize: 34,
    fontWeight: '700',
  },
  limitGlyph: {
    width: 72,
    height: 72,
    borderRadius: 99,
    backgroundColor: 'rgba(237,153,14,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  limitMark: {
    color: colors.info,
    fontSize: 34,
    fontWeight: '700',
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
  },
  resultMessage: {
    fontSize: 13,
    lineHeight: 22,
    textAlign: 'center',
    color: colors.fg50,
  },
});
