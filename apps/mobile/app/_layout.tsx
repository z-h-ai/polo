import '../src/dev/preview-install';
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthGate } from '../src/auth/AuthGate';

// POL-17: pull the connection layer into the RN bundle (WsRpcClient via the
// server-core source map + the ws stub). The singletons are inert until
// start() — POL-18 owns the start()/stop() lifecycle; this import keeps the
// bundle honest for `expo export`.
import { connectionManager } from '../src/conn/ConnectionManager';
import { PREVIEW_MODE, seedPreviewSession } from '../src/dev/preview';

// 视觉验收夹具（EXPO_PUBLIC_PREVIEW_MODE=1 构建专用）：预填演示会话。
// fetch 拦截已在 preview-install（首个 import）完成。生产构建为空操作。
if (PREVIEW_MODE) seedPreviewSession();

// RN does not ship global.Buffer; mount it before any protocol code runs.
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// POL-14: AuthGate owns the login routing decision — 未登录 -> /login，
// 已登录 -> /。It renders nothing until the SecureStore read settles so the
// wrong screen never flashes.
// POL-19: / now resolves to (tabs)/index = 消息 Tab (bottom-tab shell).
export default function RootLayout() {
  // POL-17 card: all probe/reconnect timers freeze while the app is
  // backgrounded (no battery drain), and a fresh probe cycle fires the moment
  // it returns to the foreground. Inactive (iOS control-center pull) keeps
  // the connection running — only a real background suspension pauses it.
  // Safe before login: pause()/resume() are no-ops until POL-18 calls start().
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') connectionManager.resume();
      else if (state === 'background') connectionManager.pause();
    });
    return () => subscription.remove();
  }, []);

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
        {/* POL-18: session page (messages + event cards + offline staging). */}
        <Stack.Screen name="session" />
      </Stack>
    </AuthGate>
  );
}
