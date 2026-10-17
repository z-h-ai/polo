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
export default function RootLayout() {
  return (
    <AuthGate>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
      </Stack>
    </AuthGate>
  );
}
