// P02 三态设备卡 (POL-16).
//
// One card per bound Mac: mac glyph + title + status badge row. The badge
// kind comes from inferDeviceStatus (lastSeenAt inference — POL-17 replaces
// it with real connection state); online cards tint the dot success-green
// and dim nothing, offline cards grey the dot and soften the whole card
// (prototype opacity .62). Tapping a card opens 设备管理 (P12).

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TabIcon } from './TabIcons';
import type { DeviceCardModel } from '../lib/devicesUi';
import { colors } from '../theme/tokens';

export function DeviceStatusCard({
  card,
  onPress,
}: {
  card: DeviceCardModel;
  onPress?: () => void;
}) {
  const body = (
    <>
      <View style={[styles.avatar, !card.online && styles.avatarOff]}>
        <TabIcon name="devices" color={card.online ? colors.accentDeep : colors.fg40} size={20} />
      </View>
      <View style={styles.texts}>
        <Text style={styles.title} numberOfLines={1}>
          {card.title}
        </Text>
        <View style={styles.statusRow}>
          <View
            style={[styles.dot, { backgroundColor: card.online ? colors.success : colors.fg40 }]}
          />
          <Text style={styles.status} numberOfLines={1}>
            {card.statusLabel}
          </Text>
        </View>
      </View>
      <Text style={styles.chevron}>›</Text>
    </>
  );

  if (!onPress) {
    return (
      <View style={[styles.card, card.dimmed && styles.cardDimmed]}>{body}</View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        card.dimmed && styles.cardDimmed,
        pressed && styles.pressed,
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
  },
  cardDimmed: {
    opacity: 0.62,
  },
  pressed: {
    opacity: 0.8,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOff: {
    backgroundColor: colors.fieldBg,
  },
  texts: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 99,
  },
  status: {
    flexShrink: 1,
    fontSize: 12,
    color: colors.fg50,
  },
  chevron: {
    fontSize: 20,
    color: colors.fg40,
  },
});
