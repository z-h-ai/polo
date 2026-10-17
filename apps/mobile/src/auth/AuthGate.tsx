// Login-state guard wrapping the root navigator (POL-14, decision extracted
// into authRoute.ts by POL-19).
//
// Blocks rendering until the persisted session read completes, then routes by
// auth status: signed out -> /login, signed in -> / ((tabs)/index = 消息 Tab
// since POL-19). Server-side revocation (api client refresh failure) flips the
// store back to unauthenticated and the user lands on the login screen
// automatically.

import { useEffect } from 'react';
import { usePathname, useRouter } from 'expo-router';

import { authRouteTarget, LOGIN_ROUTE } from './authRoute';
import { useSessionStore } from './session';

export { LOGIN_ROUTE };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useSessionStore((state) => state.status);
  const hydrated = useSessionStore((state) => state.hydrated);
  const restore = useSessionStore((state) => state.restore);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    const target = authRouteTarget({ hydrated, status, pathname });
    if (target !== null) {
      router.replace(target);
    }
  }, [hydrated, status, pathname, router]);

  // Hold the native splash until the secure-store read has settled, so the
  // guard decision never flashes the wrong screen.
  if (!hydrated) return null;

  return <>{children}</>;
}
