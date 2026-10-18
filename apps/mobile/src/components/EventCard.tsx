// P05 event card — the centered narrow card under a user bubble carrying the
// event-flow rows (已送达 / 执行中 / 已暂存 / 完成 / 发送失败 / 执行失败) and
// the 重新发送 action on failed turns (失败终态可重发, PRD §⑤ R2).
//
// Icons are drawn with primitives (@expo/vector-icons is not a dependency):
//   success → green check, running → ActivityIndicator, info → clock disc,
//   destructive → red cross.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { EventCardRow, EventTone } from '../session/eventCard';
import { RESEND_LABEL } from '../session/eventCard';
import { colors } from '../theme/tokens';

function RowIcon({ tone }: { tone: EventTone }) {
  if (tone === 'running') {
    return <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />;
  }
  if (tone === 'success') {
    return (
      <View style={[styles.iconBox, { borderColor: colors.success }]}>
        <View style={[styles.checkLong, { backgroundColor: colors.success }]} />
        <View style={[styles.checkShort, { backgroundColor: colors.success }]} />
      </View>
    );
  }
  if (tone === 'destructive') {
    return (
      <View style={[styles.iconBox, { borderColor: colors.destructive }]}>
        <View style={[styles.xBar, { backgroundColor: colors.destructive, transform: [{ rotate: '45deg' }] }]} />
        <View style={[styles.xBar, { backgroundColor: colors.destructive, transform: [{ rotate: '-45deg' }] }]} />
      </View>
    );
  }
  // info — clock disc (已暂存).
  return (
    <View style={[styles.iconBox, { borderColor: colors.info }]}>
      <View style={[styles.clockStub, { backgroundColor: colors.info }]} />
    </View>
  );
}

export function EventCard({
  row,
  onResend,
}: {
  row: EventCardRow;
  onResend?: () => void;
}) {
  const iconColor =
    row.tone === 'success'
      ? colors.success
      : row.tone === 'destructive'
        ? colors.destructive
        : row.tone === 'running'
          ? colors.accent
          : colors.info;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <RowIcon tone={row.tone} />
        <Text style={styles.title}>{row.title}</Text>
        <Text style={[styles.detail, { color: iconColor === colors.info ? colors.fg50 : iconColor }]}>
          {row.detail}
        </Text>
      </View>
      {row.resend && onResend ? (
        <Pressable
          accessibilityRole="button"
          onPress={onResend}
          hitSlop={8}
          style={({ pressed }) => [styles.resend, pressed && styles.pressed]}
        >
          <Text style={styles.resendLabel}>{RESEND_LABEL}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'center',
    width: '100%',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.fieldBg,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  title: {
    color: colors.foreground,
    fontWeight: '500',
    fontSize: 11.5,
  },
  detail: {
    fontSize: 11.5,
    flex: 1,
  },
  iconBox: {
    width: 12,
    height: 12,
    borderRadius: 99,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkLong: {
    position: 'absolute',
    width: 6,
    height: 1.5,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
    top: 6.5,
    left: 2,
  },
  checkShort: {
    position: 'absolute',
    width: 3.5,
    height: 1.5,
    borderRadius: 2,
    transform: [{ rotate: '-45deg' }],
    top: 5,
    left: 4.5,
  },
  xBar: {
    position: 'absolute',
    width: 7,
    height: 1.5,
    borderRadius: 2,
  },
  clockStub: {
    position: 'absolute',
    width: 1.5,
    height: 3.5,
    borderRadius: 2,
    top: 2,
  },
  spinner: {
    marginVertical: -4,
  },
  resend: {
    alignItems: 'center',
    paddingVertical: 3,
  },
  resendLabel: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.7,
  },
});
