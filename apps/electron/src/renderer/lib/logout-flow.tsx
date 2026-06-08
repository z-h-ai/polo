import React from 'react'
import LoginPage from '@/pages/LoginPage'

export type RendererLogoutFlowResult =
  | { logoutSucceeded: true }
  | { logoutSucceeded: false; logoutError: Error }

export type RendererLogoutFlowDependencies = {
  logout: () => Promise<void>
  clearRendererState: () => void | Promise<void>
  showLoginPage: () => void
}

export async function runRendererLogoutFlow({
  logout,
  clearRendererState,
  showLoginPage,
}: RendererLogoutFlowDependencies): Promise<RendererLogoutFlowResult> {
  let result: RendererLogoutFlowResult = { logoutSucceeded: true }

  try {
    await logout()
  } catch (error) {
    result = {
      logoutSucceeded: false,
      logoutError: error instanceof Error ? error : new Error(String(error)),
    }
  }

  await clearRendererState()
  showLoginPage()

  return result
}

export function LoggedOutLoginPage({ onSuccess }: { onSuccess: () => void }) {
  // After successful login, relaunch the app so the WS server and renderer
  // re-initialize with the new admin session token. Using onSuccess directly
  // would call syncPostLoginAppState which needs WS RPC — but the WS
  // connection isn't authenticated until the app restarts with the admin JWT.
  const handleLoginSuccess = () => {
    void window.electronAPI.relaunchApp()
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <LoginPage
        fetchPostLoginConfig={async () => ({ wsUrl: 'electron' })}
        onSuccess={handleLoginSuccess}
      />
    </div>
  )
}
