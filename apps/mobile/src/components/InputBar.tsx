// P05 composer — text input + send, the 按住说话 mic entry (POL-249: press =
// start capture, release = transcribe, swipe-up = cancel; a locked mic renders
// the P07 置灰+锁 press target whose tap opens the 禁按 panel) and the
// greyed-out attachment button whose tap toasts 「图片和文件发送即将上线」(P3).
//
// Safety state (绑定已解除): disabled with 「绑定解除后不可发送」 placeholder.

import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';

import { INPUT_PLACEHOLDER } from '../session/eventCard';
import { colors } from '../theme/tokens';

export function InputBar({
  onSend,
  onAttachmentPress,
  disabled = false,
  disabledPlaceholder,
  onMicPressStart,
  onMicPressMove,
  onMicPressEnd,
  micLocked = false,
  guide,
}: {
  onSend: (text: string) => void;
  onAttachmentPress: () => void;
  disabled?: boolean;
  disabledPlaceholder?: string;
  /** POL-249 按住说话手势（VoicePanel 未接管 composer 时为空）. */
  onMicPressStart?: () => void;
  onMicPressMove?: (dyPx: number) => void;
  onMicPressEnd?: () => void;
  /** P07 余额不足禁按：置灰 + 锁（点击仍进入禁按面板）. */
  micLocked?: boolean;
  /** P06 待按态首次引导气泡. */
  guide?: boolean;
}) {
  const [text, setText] = useState('');
  const pressStartY = useRef<number | null>(null);
  const canSend = !disabled && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    const value = text;
    setText('');
    onSend(value);
  };

  const micEnabled = !disabled && onMicPressStart !== undefined;
  const grantMic = (event: GestureResponderEvent) => {
    if (!micEnabled) return;
    pressStartY.current = event.nativeEvent.pageY;
    onMicPressStart?.();
  };
  const moveMic = (event: GestureResponderEvent) => {
    if (pressStartY.current === null) return;
    onMicPressMove?.(event.nativeEvent.pageY - pressStartY.current);
  };
  const endMic = () => {
    if (pressStartY.current === null) return;
    pressStartY.current = null;
    onMicPressEnd?.();
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
      {/* 按住说话 (POL-249): grant=开始录音, move=上滑判定, release=松开转文字. */}
      <View
        accessibilityRole="button"
        accessibilityLabel={micLocked ? '语音积分不足' : '按住说话'}
        accessibilityState={{ disabled: !micEnabled, busy: micLocked }}
        onStartShouldSetResponder={() => micEnabled}
        onResponderGrant={grantMic}
        onResponderMove={moveMic}
        onResponderRelease={endMic}
        onResponderTerminate={endMic}
        style={styles.micSlot}
      >
        {micLocked ? (
          <View style={[styles.roundButton, styles.mic, styles.micLocked]}>
            <View style={styles.micCapsule} />
            <View style={styles.micArc} />
            <View style={styles.micStem} />
            <View style={styles.lockBadge}>
              <View style={styles.lockShackle} />
              <View style={styles.lockBody} />
            </View>
          </View>
        ) : (
          <View style={[styles.roundButton, styles.mic, !micEnabled && styles.dimmedButton]}>
            <View style={styles.micCapsule} />
            <View style={styles.micArc} />
            <View style={styles.micStem} />
          </View>
        )}
        {guide ? (
          <View style={styles.guideBubble} pointerEvents="none">
            <Text style={styles.guideTitle}>按住 说话</Text>
            <Text style={styles.guideSub}>松开变文字 · 上滑取消</Text>
            <View style={styles.guideArrow} />
          </View>
        ) : null}
      </View>
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
  micSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  micLocked: {
    backgroundColor: colors.fieldBg,
  },
  dimmedButton: {
    opacity: 0.45,
  },
  lockBadge: {
    position: 'absolute',
    top: -4,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.foreground,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockShackle: {
    position: 'absolute',
    top: 3,
    width: 7,
    height: 5,
    borderRadius: 3.5,
    borderWidth: 1.5,
    borderColor: colors.background,
    backgroundColor: 'transparent',
  },
  lockBody: {
    position: 'absolute',
    bottom: 3,
    width: 8,
    height: 6,
    borderRadius: 2,
    backgroundColor: colors.background,
  },
  guideBubble: {
    position: 'absolute',
    right: -8,
    bottom: 46,
    backgroundColor: colors.foreground,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  guideTitle: {
    color: colors.background,
    fontSize: 13,
    fontWeight: '600',
  },
  guideSub: {
    color: 'rgba(247,248,250,0.75)',
    fontSize: 11,
    marginTop: 2,
  },
  guideArrow: {
    position: 'absolute',
    right: 18,
    bottom: -4,
    width: 9,
    height: 9,
    backgroundColor: colors.foreground,
    transform: [{ rotate: '45deg' }],
    borderRadius: 2,
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
