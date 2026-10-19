import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { SessionScreen } from '../src/screens/session/SessionScreen';

// POL-243 session route. Receives { name } (the bound Mac display name) from
// the messages-tab conversation card / device flow; back pops the stack.
export default function SessionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string }>();
  const onBack = useCallback(() => {
    if (router.canDismiss()) router.dismiss();
    else router.back();
  }, [router]);
  const deviceName = typeof params.name === 'string' && params.name ? params.name : '我的电脑';
  return <SessionScreen deviceName={deviceName} onBack={onBack} />;
}
