// P05 composer — text input + send, the 按住说话 mic entry (POL-24 占位, no
// behaviour on this card) and the greyed-out attachment button whose tap
// toasts 「图片和文件发送即将上线」 (P3 示意不可用).
//
// Safety state (绑定已解除): disabled with 「绑定解除后不可发送」 placeholder.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { INPUT_PLACEHOLDER } from '../session/eventCard';
import { colors } from '../theme/tokens';

export function InputBar({
  onSend,
  onAttachmentPress,
  disabled = false,
  disabledPlaceholder,
}: {
  onSend: (text: string) => void;
  onAttachmentPress: () => void;
  disabled?: boolean;
  disabledPlaceholder?: string;
}) {
  const [text, setText] = useState('');
  const canSend = !disabled && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    const value = text;
    setText('');
    onSend(value);
  };

  return (
    <View style={[styles.composer, disabled && styles.dimmed]}>
      <TextInput
        style={styles.input}
        value={disabled ? '' : text}
        onChangeText={setText}
        placeholder={disabled ? (disabledPlaceholder ?? INPUT_PLACEHOLDER) : INPUT_PLACEHOLDER}
        placeholderTextColor={colors.fg40}
        editable={!disabled}
        multiline={false}
        returnKeyType="send"
        onSubmitEditing={submit}
        blurOnSubmit={false}
        accessibilityLabel="输入消息"
      />
      {/* 按住说话 entry — placeholder for POL-24 (M2-5 voice flow). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="按住说话"
        disabled={disabled}
        style={({ pressed }) => [styles.roundButton, styles.mic, (pressed || disabled) && styles.dimmedButton]}
      >
        <View style={styles.micCapsule} />
        <View style={styles.micArc} />
        <View style={styles.micStem} />
      </Pressable>
      {/* Attachment — greyed out, tap toasts (P3). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="图片和文件发送即将上线"
        onPress={onAttachmentPress}
        style={({ pressed }) => [styles.roundButton, styles.attach, pressed && styles.dimmedButton]}
      >
        <View style={[styles.attachBarH]} />
        <View style={[styles.attachBarV]} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="发送"
        onPress={submit}
        disabled={!canSend}
        style={({ pressed }) => [styles.send, (!canSend || pressed) && styles.sendDisabled]}
      >
        <Text style={styles.sendLabel}>发送</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  dimmed: {
    opacity: 0.55,
  },
  input: {
    flex: 1,
    minHeight: 38,
    borderRadius: 999,
    backgroundColor: colors.fieldBg,
    paddingHorizontal: 15,
    fontSize: 13.5,
    color: colors.foreground,
    paddingVertical: 8,
  },
  roundButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mic: {
    backgroundColor: colors.accent,
  },
  dimmedButton: {
    opacity: 0.45,
  },
  micCapsule: {
    width: 8,
    height: 13,
    borderRadius: 4,
    backgroundColor: colors.background,
  },
  micArc: {
    position: 'absolute',
    bottom: 13,
    width: 14,
    height: 8,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.background,
    borderTopWidth: 0,
    backgroundColor: 'transparent',
  },
  micStem: {
    position: 'absolute',
    bottom: 9,
    width: 1.5,
    height: 4,
    backgroundColor: colors.background,
  },
  attach: {
    backgroundColor: colors.fieldBg,
    opacity: 0.55,
  },
  attachBarH: {
    position: 'absolute',
    width: 14,
    height: 1.5,
    borderRadius: 2,
    backgroundColor: colors.fg60,
  },
  attachBarV: {
    position: 'absolute',
    width: 1.5,
    height: 14,
    borderRadius: 2,
    backgroundColor: colors.fg60,
  },
  send: {
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendLabel: {
    color: colors.white,
    fontSize: 13.5,
    fontWeight: '600',
  },
});
