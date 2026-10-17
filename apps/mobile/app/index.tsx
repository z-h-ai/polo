import { StyleSheet, Text, View } from 'react-native';

import { PROTOCOL_VERSION } from '@polo-ai/shared/protocol';

// POL-5 shell route only: proves the expo-router toolchain works.
// The @polo-ai/shared/protocol import is the monorepo smoke check: the shared
// workspace package must resolve through tsc and the Metro bundle alike.
// Business screens (auth / scan / session) belong to the M1 cards.
export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Polo</Text>
      <Text style={styles.subtitle}>mobile scaffold ready · protocol v{PROTOCOL_VERSION}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 14,
    color: '#666666',
    marginTop: 8,
  },
});
