import type { OnForceLogout } from './force-logout.ts';

let globalForceLogoutHandler: OnForceLogout | undefined;

export function setGlobalForceLogoutHandler(handler: OnForceLogout | undefined): void {
  globalForceLogoutHandler = handler;
}

export function getGlobalForceLogoutHandler(): OnForceLogout | undefined {
  return globalForceLogoutHandler;
}

export function resetGlobalForceLogoutHandlerForTests(): void {
  globalForceLogoutHandler = undefined;
}
