import 'react-native-get-random-values';
import { Buffer } from 'buffer';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

// RN does not ship global.Buffer; mount it before any protocol code runs.
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
