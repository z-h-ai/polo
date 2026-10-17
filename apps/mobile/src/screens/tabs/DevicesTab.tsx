// 设备 Tab (POL-19 shell placeholder; business screen belongs to POL-16).
//
// Keeps the visual shell complete (P13/M01 tab bar context): 我的电脑 title
// plus one placeholder card stating that pairing and the device list land
// with POL-16. No device business logic on this card.

import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { LargeTitle } from '../../components/LargeTitle';
import { TabIcon } from '../../components/TabIcons';
import { colors, fontSize } from '../../theme/tokens';

export const DEVICES_TITLE = '我的电脑';
export const DEVICES_PLACEHOLDER_TITLE = '设备列表';
export const DEVICES_PLACEHOLDER_SUB = '配对与设备管理由 POL-16 实现';

export function DevicesTab() {
  return (
    <View style={styles.screen}>
      <LargeTitle title={DEVICES_TITLE} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <View style={styles.avatar}>
            <TabIcon name="devices" color={colors.accentDeep} size={20} />
          </View>
          <View style={styles.texts}>
            <Text style={styles.cardTitle}>{DEVICES_PLACEHOLDER_TITLE}</Text>
            <Text style={styles.cardSub}>{DEVICES_PLACEHOLDER_SUB}</Text>
          </View>
          <View style={styles.chip}>
            <Text style={styles.chipText}>POL-16 · 即将上线</Text>
          </View>
        </View>
        <Text style={styles.footerHint}>
          绑定电脑后，可在消息 Tab 与电脑上的 Polo AI 对话
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingTop: 8,
    gap: 14,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  cardTitle: {
    fontSize: fontSize.body,
    fontWeight: '600',
    color: colors.foreground,
  },
  cardSub: {
    fontSize: fontSize.toast,
    color: colors.fg50,
  },
  chip: {
    paddingHorizontal: 8,
    height: 20,
    borderRadius: 999,
    backgroundColor: colors.fieldBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 10.5,
    color: colors.fg60,
  },
  footerHint: {
    fontSize: 11.5,
    lineHeight: 18,
    textAlign: 'center',
    color: colors.fg40,
  },
});
