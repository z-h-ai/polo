// P05 connection status bar — the thin 28px strip under the nav title.
//
// Four steady states from the POL-242 ConnectionManager (ConnStatus) plus the
// 安全态 override (auth fatal → 绑定已解除, destructive, P05 screen 5):
//   online-lan      已连接 · Wi-Fi 直连   (green)
//   online-relay    已连接 · 经云中转     (accent)
//   reconnecting    正在重连…（经云中转） (info, spinner)
//   offline         离线                  (muted)

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { ConnStatus } from '../conn/ConnectionManager';
import { STATUS_LABELS } from '../conn/ConnectionManager';
import { FATAL_STATUS_LABEL } from '../session/eventCard';
import { colors } from '../theme/tokens';

const STATE_COLORS: Record<ConnStatus, { fg: string; bg: string }> = {
  'online-lan': { fg: colors.success, bg: 'rgba(9,137,38,0.09)' },
  'online-relay': { fg: colors.accent, bg: colors.accentSoft },
  reconnecting: { fg: colors.info, bg: 'rgba(237,153,14,0.1)' },
  offline: { fg: colors.fg50, bg: colors.fieldBg },
};

export function ConnectionStatusBar({
  status,
  fatal,
}: {
  status: ConnStatus;
  fatal: boolean;
}) {
  if (fatal) {
    return (
      <View style={[styles.bar, { backgroundColor: colors.destructiveBg }]}>
        <View style={styles.xGlyph} />
        <Text style={[styles.label, { color: colors.destructive }]}>{FATAL_STATUS_LABEL}</Text>
      </View>
    );
  }
  const palette = STATE_COLORS[status];
  return (
    <View style={[styles.bar, { backgroundColor: palette.bg }]}>
      {status === 'reconnecting' ? (
        <ActivityIndicator size="small" color={palette.fg} style={styles.spinner} />
      ) : (
        <View style={[styles.dot, { backgroundColor: palette.fg }]} />
      )}
      <Text style={[styles.label, { color: palette.fg }]}>{STATUS_LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 99,
  },
  xGlyph: {
    width: 9,
    height: 9,
    borderRadius: 2,
    backgroundColor: colors.destructive,
  },
  spinner: {
    // ActivityIndicator inside a 28px row — tuck it to the text baseline.
    marginVertical: -4,
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
  },
});
