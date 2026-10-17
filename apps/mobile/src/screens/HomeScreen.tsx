// Signed-in home placeholder (POL-14, entry row added by POL-15).
//
// Proves the authenticated route and the credential chain: shows the signed-in
// user summary pulled from the session store and the logout action
// (POST /api/auth/logout + local clear). The 扫码授权登录 row navigates to the
// QR authorize flow (P13 account-card style). Business screens belong to later
// M1/M2 cards; keeps the protocol-version smoke check from the POL-5 scaffold.

import { useState } from 'react';
import { Text, View, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { useSessionStore } from '../auth/session';
import { colors, fontSize } from '../theme/tokens';
import { PROTOCOL_VERSION } from '@polo-ai/shared/protocol';

export function HomeScreen() {
  const user = useSessionStore((state) => state.user);
  const isNewUser = useSessionStore((state) => state.isNewUser);
  const signOut = useSessionStore((state) => state.signOut);
  const router = useRouter();
  // Local busy flag: the shared status machine never enters 'authenticating'
  // during signOut, so the label is driven here.
  const [signingOut, setSigningOut] = useState(false);

  const onPressSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>已登录</Text>
        <Text style={styles.line}>手机号：{user ? user.phone : '-'}</Text>
        <Text style={styles.line}>用户 ID：{user ? user.id : '-'}</Text>
        {isNewUser !== null ? (
          <Text style={styles.line}>{isNewUser ? '本次为注册并登录' : '本次为已有账号登录'}</Text>
        ) : null}
        <Text style={styles.muted}>protocol v{PROTOCOL_VERSION}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/scan-qr')}
        style={({ pressed }) => [styles.entryRow, pressed && styles.pressed]}
      >
        <View style={styles.entryBadge}>
          <Text style={styles.entryBadgeText}>P</Text>
        </View>
        <View style={styles.entryTexts}>
          <Text style={styles.entryTitle}>扫码授权登录</Text>
          <Text style={styles.entrySub}>扫电脑或网页上的二维码，授权其登录</Text>
        </View>
        <Text style={styles.entryChevron}>›</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: signingOut }}
        disabled={signingOut}
        onPress={() => void onPressSignOut()}
        style={({ pressed }) => [styles.logout, (pressed || signingOut) && styles.logoutPressed]}
      >
        <Text style={styles.logoutLabel}>{signingOut ? '退出中…' : '退出登录'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 24,
  },
  card: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 18,
    gap: 6,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 4,
  },
  line: {
    fontSize: fontSize.body,
    color: colors.foreground,
  },
  muted: {
    fontSize: fontSize.toast,
    color: colors.fg50,
    marginTop: 4,
  },
  entryRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 14,
  },
  entryBadge: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryBadgeText: {
    color: colors.accentDeep,
    fontSize: 17,
    fontWeight: '700',
  },
  entryTexts: {
    flex: 1,
    gap: 2,
  },
  entryTitle: {
    fontSize: fontSize.body,
    fontWeight: '500',
    color: colors.foreground,
  },
  entrySub: {
    fontSize: fontSize.toast,
    color: colors.fg50,
  },
  entryChevron: {
    fontSize: 20,
    color: colors.fg40,
  },
  pressed: {
    opacity: 0.7,
  },
  logout: {
    height: 48,
    alignSelf: 'stretch',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.buttonBorder,
  },
  logoutPressed: {
    opacity: 0.7,
  },
  logoutLabel: {
    fontSize: fontSize.button,
    fontWeight: '500',
    color: colors.destructive,
  },
});
