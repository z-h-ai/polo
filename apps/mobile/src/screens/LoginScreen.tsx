// Login screen (POL-239, P01).
//
// Logo block + phone/code form + send-success toast, mirroring the prototype:
// white toast card with a green check, 「验证码已发送至 138 0000 8000，5 分钟内有效」.

import { useEffect } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { PhoneCodeForm } from '../components/PhoneCodeForm';
import { useSessionStore } from '../auth/session';
import { colors, fontSize, radius } from '../theme/tokens';

const TOAST_VISIBLE_MS = 3500;

export function LoginScreen() {
  const toast = useSessionStore((state) => state.toast);
  const dismissToast = useSessionStore((state) => state.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissToast, TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <View style={styles.header}>
          <View style={styles.logo}>
            <Text style={styles.logoGlyph}>P</Text>
          </View>
          <Text style={styles.title}>Polo</Text>
          <Text style={styles.subtitle}>验证手机号即可登录或注册</Text>
        </View>

        <PhoneCodeForm />
      </View>

      {toast ? (
        <View style={styles.toast} accessibilityLiveRegion="polite">
          <View style={styles.toastCheck}>
            <Text style={styles.toastCheckGlyph}>✓</Text>
          </View>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  body: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 34,
  },
  header: {
    alignItems: 'center',
    marginBottom: 26,
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: radius.logo,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoGlyph: {
    color: colors.white,
    fontSize: 30,
    fontWeight: '700',
  },
  title: {
    marginTop: 16,
    fontSize: fontSize.title,
    fontWeight: '600',
    color: colors.foreground,
  },
  subtitle: {
    marginTop: 6,
    fontSize: fontSize.subtitle,
    color: colors.fg50,
  },
  toast: {
    position: 'absolute',
    top: 10,
    left: 20,
    right: 20,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    padding: 11,
    paddingHorizontal: 14,
    borderRadius: radius.toast,
    backgroundColor: colors.white,
    // approximation of the prototype's layered shadow-strong
    shadowColor: colors.foreground,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  toastCheck: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  toastCheckGlyph: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 13,
  },
  toastText: {
    flex: 1,
    fontSize: fontSize.toast,
    lineHeight: 18,
    color: colors.foreground,
  },
});
