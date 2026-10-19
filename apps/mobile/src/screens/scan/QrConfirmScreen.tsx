// Confirm screen for QR login authorization (POL-240, prototype P11).
//
// Opened by the scan screen with { qrId, secret, requester } — the requester
// JSON comes from the POST /api/auth/qr/scan response, so the card renders
// the real 请求端 info (设备类型 / ipMasked / 发起时间 from admin's createdAt)
// instead of placeholders; a deep link without the param falls back to the
// status view's requester (仅核对，不参与授权 — C3, the「以上信息仅用于核对」
// footnote stays). Flow: the user either 确认登录 (POST confirm with this
// phone's JWT) or 不是我，拒绝. Terminal tickets and api failures fall back
// to the P10 alert (重新扫码 / 返回). Both action buttons are disabled while
// a request is in flight (no double submits), and failures surface a
// retryable alert instead of failing silently.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { qrLoginApi } from '../../api/qrLogin';
import type { QrStatusView } from '../../api/qrLogin';
import {
  parseScanRequesterParam,
  qrErrorToAlertCopy,
  requesterCardModel,
  statusToUiState,
  ticketStatusAlertCopy,
} from '../../lib/qrLoginUi';
import type { QrErrorAlertCopy } from '../../lib/qrLoginUi';
import { colors, fontSize, radius } from '../../theme/tokens';

type Phase =
  | 'checking'
  | 'ready'
  | 'confirming'
  | 'rejecting'
  | 'success'
  | 'rejectedFeedback'
  | 'failed';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function QrConfirmScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    qrId?: string | string[];
    secret?: string | string[];
    requester?: string | string[];
  }>();
  const qrId = firstParam(params.qrId);
  const secret = firstParam(params.secret);

  const [phase, setPhase] = useState<Phase>('checking');
  const [view, setView] = useState<QrStatusView | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);

  // Real requester card from the scan response (see parseScanRequesterParam);
  // null for deep links — the card then falls back to the status view.
  const [scanRequester] = useState(() => parseScanRequesterParam(params.requester));

  // Local clock at open: the fallback 发起时间 when the scan param carried no
  // parseable createdAt (admin contract gap covered by the scan endpoint).
  const [scannedAt] = useState(() => new Date());

  const busy = phase === 'confirming' || phase === 'rejecting';

  const finishFlow = useCallback(() => {
    // 完成 pops the whole authorize flow (scan + confirm) back to Home.
    router.dismissAll();
  }, [router]);

  const goBack = useCallback(() => {
    if (router.canDismiss()) router.dismiss();
    else router.back();
  }, [router]);

  const showRescanAlert = useCallback(
    (copy: QrErrorAlertCopy) => {
      Alert.alert(
        copy.title,
        copy.message,
        [
          { text: '重新扫码', style: 'default', onPress: () => router.replace('/scan-qr') },
          { text: '返回', style: 'cancel', onPress: goBack },
        ],
        { cancelable: false },
      );
    },
    [goBack, router],
  );

  const showRetryAlert = useCallback(
    (copy: QrErrorAlertCopy, retry: () => void) => {
      Alert.alert(
        copy.title,
        copy.message,
        [
          { text: '重试', style: 'default', onPress: retry },
          { text: '返回', style: 'cancel', onPress: goBack },
        ],
        { cancelable: false, onDismiss: () => setPhase('ready') },
      );
    },
    [goBack],
  );

  /** One status read; routes the result to ready / success / rescan alert. */
  const checkStatus = useCallback(async (): Promise<boolean> => {
    if (!qrId || !secret) {
      setPhase('failed');
      showRescanAlert({
        title: '不是 Polo 登录二维码',
        message: '这不是 Polo 登录二维码，请核对后再试',
      });
      return false;
    }
    try {
      const next = await qrLoginApi.getStatus(qrId);
      setView(next);
      const uiState = statusToUiState(next.status);
      if (uiState === 'ready') {
        setRemainingSec(next.expiresInSeconds);
        setPhase('ready');
        return true;
      }
      if (uiState === 'success') {
        setPhase('success');
        return true;
      }
      setPhase('failed');
      showRescanAlert(ticketStatusAlertCopy(next.status) ?? { title: '二维码无效', message: '请让电脑或网页端刷新二维码后重新扫码' });
      return false;
    } catch (error) {
      setPhase('failed');
      showRescanAlert(qrErrorToAlertCopy(error));
      return false;
    }
  }, [qrId, secret, showRescanAlert]);

  // Initial load. The alert is the error surface; the screen behind it just
  // keeps the dark background.
  useEffect(() => {
    void checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Validity countdown; at zero, re-read the ticket so the expiry call is the
  // server's (client clock skew should not expire a live ticket).
  const checkingRef = useRef(false);
  useEffect(() => {
    if (phase !== 'ready') return;
    if (remainingSec <= 0) {
      if (checkingRef.current) return;
      checkingRef.current = true;
      void checkStatus().finally(() => {
        checkingRef.current = false;
      });
      return;
    }
    const timer = setTimeout(() => setRemainingSec((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, remainingSec, checkStatus]);

  const onConfirm = useCallback(async () => {
    if (!qrId || !secret || busy) return;
    setPhase('confirming');
    try {
      const result = await qrLoginApi.confirm({ qrId, secret });
      if (statusToUiState(result.status) === 'success') {
        setView(result);
        setPhase('success');
      } else {
        setPhase('failed');
        showRescanAlert(ticketStatusAlertCopy(result.status) ?? { title: '二维码无效', message: '请让电脑或网页端刷新二维码后重新扫码' });
      }
    } catch (error) {
      setPhase('ready');
      showRetryAlert(qrErrorToAlertCopy(error), () => void onConfirm());
    }
  }, [busy, qrId, secret, showRescanAlert, showRetryAlert]);

  const onReject = useCallback(async () => {
    if (!qrId || !secret || busy) return;
    setPhase('rejecting');
    try {
      const result = await qrLoginApi.reject({ qrId, secret });
      if (statusToUiState(result.status) === 'rejected') {
        setView(result);
        setPhase('rejectedFeedback');
      } else {
        setPhase('failed');
        showRescanAlert(ticketStatusAlertCopy(result.status) ?? { title: '二维码无效', message: '请让电脑或网页端刷新二维码后重新扫码' });
      }
    } catch (error) {
      setPhase('ready');
      showRetryAlert(qrErrorToAlertCopy(error), () => void onReject());
    }
  }, [busy, qrId, secret, showRescanAlert, showRetryAlert]);

  // P11 requester card: prefer the scan response's requester (it carries
  // createdAt), fall back to the status view's, and degrade field by field.
  const card = useMemo(
    () =>
      requesterCardModel(
        scanRequester ??
          (view?.requester
            ? { ...view.requester, createdAt: null }
            : null),
        scannedAt,
      ),
    [scanRequester, view, scannedAt],
  );

  if (phase === 'checking') {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (phase === 'success') {
    return (
      <View style={[styles.screen, styles.center, styles.successGap]}>
        <View style={styles.successBadge}>
          <Text style={styles.successBadgeText}>✓</Text>
        </View>
        <Text style={styles.successTitle}>已授权</Text>
        <Text style={styles.successMessage}>
          {card.device} 将自动完成登录。{'\n'}本次授权已记录到登录审计。
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={finishFlow}
          style={({ pressed }) => [styles.primaryButton, styles.wideButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonLabel}>完成</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'rejectedFeedback') {
    return (
      <View style={[styles.screen, styles.center, styles.successGap]}>
        <View style={styles.rejectedBadge}>
          <Text style={styles.rejectedBadgeText}>✕</Text>
        </View>
        <Text style={styles.successTitle}>已拒绝本次登录</Text>
        <Text style={styles.successMessage}>
          该二维码已作废，对方将无法登录。{'\n'}如非你本人操作，请留意账号安全。
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={finishFlow}
          style={({ pressed }) => [styles.primaryButton, styles.wideButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonLabel}>完成</Text>
        </Pressable>
      </View>
    );
  }

  // 'ready' (confirm UI), 'confirming'/'rejecting' (same UI, buttons locked)
  // and 'failed' (dark background behind the alert) all land here.
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={goBack} hitSlop={12}>
          <Text style={styles.headerBack}>‹ 取消</Text>
        </Pressable>
        <Text style={styles.headerTitle}>授权确认</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.body}>
        <View style={styles.hero}>
          <View style={styles.heroBadge}>
            {/* V-08: shield mark (proto i-shield: purple outline + check),
                drawn with views — no react-native-svg dependency. */}
            <View style={styles.shieldMark}>
              <View style={styles.shieldBody} />
              <View style={styles.shieldTip} />
              <Text style={styles.shieldCheck}>✓</Text>
            </View>
          </View>
          <Text style={styles.heroTitle}>授权该设备登录你的账号？</Text>
          <Text style={styles.heroSub}>对方将在你确认后自动完成登录</Text>
        </View>

        <View style={styles.card}>
          {/* P11 requester card — real values from the scan endpoint's
              requester (设备类型/ipMasked/发起时间); each row degrades alone. */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>设备</Text>
            <Text style={styles.rowValue}>{card.device}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>位置/IP</Text>
            <Text style={styles.rowValue}>{card.ip}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>时间</Text>
            <Text style={styles.rowValue}>{formatTimestamp(new Date(card.requestedAtMs))}</Text>
          </View>
          <Text style={styles.cardFootnote}>以上信息仅用于核对，不作为登录依据</Text>
        </View>

        <Text style={styles.validity}>
          {phase === 'ready' && remainingSec > 0
            ? `二维码 ${formatClock(remainingSec)} 内有效，超时请重新扫码`
            : '二维码 2 分钟内有效，超时请重新扫码'}
        </Text>

        <View style={styles.infobar}>
          <Text style={styles.infobarText}>
            <Text style={styles.infobarIcon}>⚠️ </Text>
            如果这次登录不是你本人发起，请点「不是我，拒绝」，并尽快在网页端「账号安全」中修改密码。
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void onConfirm()}
            style={({ pressed }) => [
              styles.primaryButton,
              (pressed || busy) && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonLabel}>
              {phase === 'confirming' ? '确认中…' : '确认登录'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void onReject()}
            style={({ pressed }) => [
              styles.dangerButton,
              (pressed || busy) && styles.pressed,
            ]}
          >
            <Text style={styles.dangerButtonLabel}>
              {phase === 'rejecting' ? '提交中…' : '不是我，拒绝'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 16,
  },
  headerBack: {
    width: 64,
    color: colors.foreground,
    fontSize: 13.5,
    opacity: 0.85,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.foreground,
    fontSize: 15,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 64,
  },
  body: {
    flex: 1,
    padding: 22,
    gap: 16,
  },
  hero: {
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  heroBadge: {
    width: 56,
    height: 56,
    borderRadius: radius.logo,
    // Opaque flatten of accentSoft over the screen background: the shield tip
    // masks the body's bottom arc with this exact color (see shieldTip).
    backgroundColor: colors.accentSoftSolid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // V-08 shield mark — 24×29 silhouette from the prototype's i-shield path:
  // rounded-top body, curved flanks, pointed tip, ✓ centered inside.
  shieldMark: {
    width: 24,
    height: 29,
  },
  shieldBody: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.accent,
    // flatter shoulders than a circle so the silhouette reads as a shield
    // (proto i-shield), not a map pin
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  shieldTip: {
    // 45°-rotated square stroked on its two lower edges → the pointed bottom.
    // The opaque badge-tinted fill hides the body's bottom arc underneath;
    // its edges are tangent to that arc, so the strokes join cleanly.
    position: 'absolute',
    top: 14.5,
    left: 6,
    width: 12,
    height: 12,
    transform: [{ rotate: '45deg' }],
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoftSolid,
  },
  shieldCheck: {
    position: 'absolute',
    top: 7,
    left: 0,
    width: 24,
    textAlign: 'center',
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  heroTitle: {
    color: colors.foreground,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  heroSub: {
    color: colors.fg50,
    fontSize: 12.5,
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowLabel: {
    width: 64,
    color: colors.fg50,
    fontSize: 12.5,
  },
  rowValue: {
    flex: 1,
    color: colors.foreground,
    fontSize: fontSize.body,
    fontWeight: '500',
  },
  cardFootnote: {
    color: colors.fg50,
    fontSize: 11,
    lineHeight: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 9,
  },
  validity: {
    color: colors.fg50,
    fontSize: 11,
    textAlign: 'center',
  },
  infobar: {
    // V-04: amber anti-phishing hint card (prototype .infobar).
    backgroundColor: colors.warningBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warningBorder,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  infobarText: {
    color: colors.warning,
    fontSize: 12.5,
    lineHeight: 19,
  },
  infobarIcon: {
    color: colors.warning,
    fontSize: 12,
  },
  actions: {
    marginTop: 'auto',
    gap: 10,
    paddingBottom: 26,
  },
  primaryButton: {
    height: 48,
    borderRadius: radius.field,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  primaryButtonLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  dangerButton: {
    // V-10: light-red filled reject button (prototype .btnD).
    height: 48,
    borderRadius: radius.field,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.dangerBorder,
  },
  dangerButtonLabel: {
    color: colors.destructive,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  wideButton: {
    alignSelf: 'stretch',
    marginTop: 12,
  },
  successGap: {
    gap: 14,
  },
  successBadge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(9,137,38,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successBadgeText: {
    color: colors.success,
    fontSize: 32,
    fontWeight: '700',
  },
  rejectedBadge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.destructiveBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectedBadgeText: {
    color: colors.destructive,
    fontSize: 28,
    fontWeight: '700',
  },
  successTitle: {
    color: colors.foreground,
    fontSize: 18,
    fontWeight: '600',
  },
  successMessage: {
    color: colors.fg50,
    fontSize: 13,
    lineHeight: 22,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
});
