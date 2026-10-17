// Login-state guard wrapping the root navigator (POL-14).
//
// Blocks rendering until the persisted session read completes, then routes by
// auth status: signed out -> /login, signed in -> /. Server-side revocation
// (api client refresh failure) flips the store back to unauthenticated and the
// user lands on the login screen automatically.

import { useEffect } from 'react';
import { usePathname, useRouter } from 'expo-router';

import { useSessionStore } from './session';

export const LOGIN_ROUTE = '/login';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useSessionStore((state) => state.status);
  const hydrated = useSessionStore((state) => state.hydrated);
  const restore = useSessionStore((state) => state.restore);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    void restore();
  }, [restore]);

  const onLoginRoute = pathname === LOGIN_ROUTE;

  useEffect(() => {
    if (!hydrated) return;
    if (status === 'authenticated' && onLoginRoute) {
      router.replace('/');
    } else if (status !== 'authenticated' && !onLoginRoute) {
      router.replace(LOGIN_ROUTE);
    }
  }, [hydrated, status, onLoginRoute, router]);

  // Hold the native splash until the secure-store read has settled, so the
  // guard decision never flashes the wrong screen.
  if (!hydrated) return null;

  return <>{children}</>;
}
