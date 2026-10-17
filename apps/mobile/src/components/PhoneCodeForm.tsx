// Phone + code form (POL-14, P01).
//
// Covers the three prototype states:
//  - 初始未发码: 获取验证码 disabled (opacity .5) until the phone number is
//    complete; 继续 disabled until a full code exists;
//  - 填写态: send-success toast (rendered by LoginScreen) + resend countdown;
//  - 错误态: error bar above the form, rate-limit copy under the code field.

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CountdownButton } from './CountdownButton';
import { useSessionStore } from '../auth/session';
import { colors, fontSize, radius, spacing } from '../theme/tokens';

export const PHONE_DIGITS = 11;
export const CODE_DIGITS = 6;

export function isValidPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

export function PhoneCodeForm() {
  const status = useSessionStore((state) => state.status);
  const error = useSessionStore((state) => state.error);
  const errorCode = useSessionStore((state) => state.errorCode);
  const countdown = useSessionStore((state) => state.countdown);
  const remainingSec = useSessionStore((state) => state.remainingSec);
  const sendCode = useSessionStore((state) => state.sendCode);
  const verify = useSessionStore((state) => state.verify);
  const tick = useSessionStore((state) => state.tick);

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);

  const phoneReady = isValidPhone(phone);
  const codeReady = code.length >= CODE_DIGITS;
  const busy = status === 'authenticating';
  const rateLimited = errorCode === 'sms_rate_limited';

  const onPressSend = async () => {
    if (!phoneReady || sending) return;
    setSending(true);
    try {
      await sendCode(phone);
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.form}
    >
      {error ? (
        <View style={styles.errorBar} accessibilityLiveRegion="polite">
          <Text style={styles.errorIcon}>!</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View>
        <Text style={styles.label}>手机号</Text>
        <TextInput
          style={styles.input}
          placeholder="请输入手机号"
          placeholderTextColor={colors.fg40}
          keyboardType="number-pad"
          maxLength={PHONE_DIGITS}
          value={phone}
          onChangeText={(value) => setPhone(value.replace(/\D/g, '').slice(0, PHONE_DIGITS))}
          editable={!busy}
          autoComplete="tel"
        />
      </View>

      <View>
        <Text style={styles.label}>验证码</Text>
        <View style={styles.codeRow}>
          <TextInput
            style={[styles.input, styles.codeInput, rateLimited && styles.codeInvalid]}
            placeholder="请输入验证码"
            placeholderTextColor={colors.fg40}
            keyboardType="number-pad"
            maxLength={CODE_DIGITS}
            value={code}
            onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, CODE_DIGITS))}
            editable={!busy}
          />
          <CountdownButton
            idleLabel="获取验证码"
            remainingSec={remainingSec}
            kind={countdown?.kind ?? null}
            disabled={!phoneReady}
            busy={sending}
            onTick={tick}
            onPress={() => void onPressSend()}
          />
        </View>
        <Text style={[styles.hint, rateLimited && styles.hintError]}>
          {rateLimited
            ? '短信发送过于频繁，请稍后再试。'
            : '验证码 5 分钟内有效 · 未注册的手机号验证通过后自动创建账号'}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !codeReady || busy }}
        disabled={!codeReady || busy}
        onPress={() => void verify(phone, code)}
        style={({ pressed }) => [
          styles.primary,
          (!codeReady || busy || pressed) && styles.primaryDisabled,
        ]}
      >
        <Text style={styles.primaryLabel}>{busy ? '登录中…' : '继续'}</Text>
      </Pressable>

      <Text style={styles.agreement}>继续即表示同意《用户协议》与《隐私政策》</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.fieldGap,
  },
  label: {
    fontSize: fontSize.fieldLabel,
    fontWeight: '500',
    color: colors.fg60,
    marginBottom: spacing.labelGap,
  },
  input: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.fieldBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 14,
    fontSize: fontSize.body,
    color: colors.foreground,
  },
  codeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  codeInput: {
    flex: 1,
    letterSpacing: 4.5, // .3em feel from the prototype code field
    fontWeight: '600',
  },
  codeInvalid: {
    color: colors.destructive,
  },
  hint: {
    fontSize: fontSize.hint,
    color: colors.fg50,
    marginTop: spacing.labelGap,
    lineHeight: 17,
  },
  hintError: {
    color: colors.destructive,
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
  primary: {
    height: 48,
    borderRadius: radius.field,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryDisabled: {
    opacity: 0.5,
  },
  primaryLabel: {
    color: colors.white,
    fontSize: fontSize.button,
    fontWeight: '600',
  },
  agreement: {
    fontSize: fontSize.agreement,
    color: colors.fg50,
    textAlign: 'center',
    lineHeight: 19,
  },
});
