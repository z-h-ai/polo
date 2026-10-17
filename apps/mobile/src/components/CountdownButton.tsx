// Secondary action button with countdown display (POL-14, P01).
//
// Idle: 获取验证码 (disabled + opacity .5 when the caller says so, e.g. empty
// phone). Counting: 「已发送 · Ns 后可重发」/「限流 · Ns 后可重发」, rendered at
// opacity .5 and unpressable until the countdown clears. The ticking itself
// lives in the session store (local clock); this component only drives the
// interval.

import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { colors, fontSize, radius } from '../theme/tokens';

export interface CountdownButtonProps {
  idleLabel: string;
  remainingSec: number;
  /** 'cooldown' -> 已发送 · Ns 后可重发; 'rate_limited' -> 限流 · Ns 后可重发. */
  kind: 'cooldown' | 'rate_limited' | null;
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
  /** Drives store tick(); injectable for tests/previews. */
  onTick?: () => void;
}

export function countdownLabel(remainingSec: number, kind: 'cooldown' | 'rate_limited'): string {
  return kind === 'rate_limited'
    ? `限流 · ${remainingSec}s 后可重发`
    : `已发送 · ${remainingSec}s 后可重发`;
}

export function CountdownButton({
  idleLabel,
  remainingSec,
  kind,
  disabled = false,
  busy = false,
  onPress,
  onTick,
}: CountdownButtonProps) {
  const counting = kind !== null && remainingSec > 0;

  useEffect(() => {
    if (!counting) return;
    const tick = onTick ?? (() => {});
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [counting, onTick]);

  const isDisabled = disabled || counting || busy;
  const label = busy
    ? '发送中…'
    : counting && kind
      ? countdownLabel(remainingSec, kind)
      : idleLabel;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        (isDisabled || pressed) && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.fg60} />
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 48,
    paddingHorizontal: 14,
    borderRadius: radius.field,
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 132,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    fontSize: fontSize.action,
    fontWeight: '500',
    color: colors.foreground,
    textAlign: 'center',
  },
});
