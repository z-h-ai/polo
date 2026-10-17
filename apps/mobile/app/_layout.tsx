import 'react-native-get-random-values';
import { Buffer } from 'buffer';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthGate } from '../src/auth/AuthGate';

// RN does not ship global.Buffer; mount it before any protocol code runs.
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// POL-14: AuthGate owns the login routing decision — 未登录 -> /login，
// 已登录 -> /。It renders nothing until the SecureStore read settles so the
// wrong screen never flashes.
// POL-19: / now resolves to (tabs)/index = 消息 Tab (bottom-tab shell).
export default function RootLayout() {
  return (
    <AuthGate>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" />
        <Stack.Screen name="scan-qr" />
        <Stack.Screen name="qr-confirm" />
        {/* POL-16: pairing flow + device management (placeholder route removed). */}
        <Stack.Screen name="pair" />
        <Stack.Screen name="device-manage" />
      </Stack>
    </AuthGate>
  );
}
