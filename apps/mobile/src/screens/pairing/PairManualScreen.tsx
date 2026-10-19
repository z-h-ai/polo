// P03 输码屏 (POL-241 第 2 屏).
//
// 6-digit manual entry as the scan-equivalent entry (P03: 与扫码等效入口):
// errbar for 无效/过期 feedback, mono letter-spaced field, the 5-min one-time
// hint, and a 绑定 button that submits straight to admin bind (bind errors
// render in the errbar except the limit case, which the flow container turns
// into the P04 整屏错误态).

import { Pressable, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';
import type { TextStyle } from 'react-native';

import { sanitizePairingCodeInput } from '../../lib/pairingPayload';
import { isPairingCodeReady } from '../../lib/pairingUi';
import { colors, fontSize, radius } from '../../theme/tokens';

// V-05: on web the UA paints an amber focus ring on the autofocused input
// (headless Chromium AccentColor), which read as an error state. RNW honors
// the outline* longforms but RN core types don't declare them → cast.
const webOutlineReset = (Platform.OS === 'web'
  ? { outlineStyle: 'none', outlineWidth: 0, outlineColor: 'transparent' }
  : {}) as TextStyle;

export function PairManualScreen({
  error,
  busy,
  onSubmit,
  onBack,
}: {
  /** Bound error-bar copy (P03 errbar); null hides the bar. */
  error: string | null;
  busy: boolean;
  onSubmit: (code: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [fieldFocused, setFieldFocused] = useState(false);
  const ready = isPairingCodeReady(code);

  return (
    <View style={styles.screen}>
      <View style={styles.navBar}>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title}>手动输入配对码</Text>
        <View style={styles.navSpacer} />
      </View>
      <View style={styles.body}>
        <Text style={styles.lead}>
          无法扫码？在电脑上打开 Polo{'\n'}「设置 → 手机连接」页输入下方 6 位配对码
        </Text>
        {error ? (
          <View style={styles.errorBar} accessibilityLiveRegion="polite">
            <Text style={styles.errorIcon}>!</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        <TextInput
          style={[styles.codeField, fieldFocused && styles.codeFieldFocused]}
          placeholder="······"
          placeholderTextColor={colors.fg40}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          maxLength={6}
          value={code}
          onChangeText={(value) => setCode(sanitizePairingCodeInput(value))}
          onFocus={() => setFieldFocused(true)}
          onBlur={() => setFieldFocused(false)}
          editable={!busy}
          autoFocus
        />
        <Text style={styles.hint}>配对码 5 分钟内有效 · 一次性使用</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready || busy }}
          disabled={!ready || busy}
          onPress={() => onSubmit(code)}
          style={({ pressed }) => [styles.submit, (!ready || busy || pressed) && styles.submitDim]}
        >
          <Text style={styles.submitLabel}>{busy ? '绑定中…' : '绑定'}</Text>
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
    backgroundColor: colors.background,
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
    paddingHorizontal: 24,
    paddingTop: 26,
    gap: 14,
  },
  lead: {
    fontSize: 12.5,
    lineHeight: 22,
    textAlign: 'center',
    color: colors.fg50,
  },
  errorBar: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    padding: 10,
    paddingHorizontal: 12,
    borderRadius: radius.errorBar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.destructiveBorder,
    backgroundColor: colors.destructiveBg,
  },
  errorIcon: {
    color: colors.destructive,
    fontSize: fontSize.error,
    fontWeight: '700',
  },
  errorText: {
    flex: 1,
    color: colors.destructive,
    fontSize: fontSize.error,
    lineHeight: 19,
  },
  codeField: {
    height: 52,
    borderRadius: radius.field,
    backgroundColor: colors.fieldBg,
    borderWidth: 1,
    borderColor: colors.fieldBorder, // V-05: neutral gray, not an error signal
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 10,
    color: colors.foreground,
    ...webOutlineReset,
  },
  codeFieldFocused: {
    borderColor: colors.accent, // focus keeps the accent edge (V-05 allowance)
  },
  hint: {
    fontSize: fontSize.hint,
    textAlign: 'center',
    color: colors.fg50,
  },
  submit: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  submitDim: {
    opacity: 0.5,
  },
  submitLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
});
