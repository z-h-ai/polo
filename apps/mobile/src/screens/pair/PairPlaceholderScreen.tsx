// P03 pairing placeholder (POL-19).
//
// The 消息 Tab empty state's 「去绑定电脑」 button needs a P03 destination;
// the real pairing flow (scan the computer's pairing code, bind) is POL-16.
// This screen keeps the route stable and the shell visually complete until
// then — POL-16 replaces this file's content in place.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { TabIcon } from '../../components/TabIcons';
import { colors, fontSize } from '../../theme/tokens';

export const PAIR_PLACEHOLDER_TITLE = '绑定电脑';
export const PAIR_PLACEHOLDER_SUB = '配对扫码流程由 POL-16 实现';

export function PairPlaceholderScreen() {
  const router = useRouter();
  return (
    <View style={styles.screen}>
      <View style={styles.body}>
        <View style={styles.glyph}>
          <TabIcon name="devices" color={colors.fg40} size={40} />
        </View>
        <Text style={styles.title}>{PAIR_PLACEHOLDER_TITLE}</Text>
        <Text style={styles.sub}>{PAIR_PLACEHOLDER_SUB}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Text style={styles.backText}>返回</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 24,
    justifyContent: 'center',
    gap: 24,
  },
  body: {
    alignItems: 'center',
    gap: 12,
  },
  glyph: {
    width: 84,
    height: 84,
    borderRadius: 24,
    backgroundColor: colors.fieldBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  sub: {
    fontSize: 12.5,
    textAlign: 'center',
    color: colors.fg50,
  },
  backButton: {
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    fontSize: fontSize.button,
    fontWeight: '500',
    color: colors.foreground,
  },
  pressed: {
    opacity: 0.7,
  },
});
