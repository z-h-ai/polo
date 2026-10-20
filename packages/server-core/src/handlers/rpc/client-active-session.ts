interface ClientActiveSession {
  workspaceId: string
  sessionId: string
}

const activeSessionsByClient = new Map<string, ClientActiveSession>()

export function bindClientActiveSession(
  clientId: string,
  workspaceId: string,
  sessionId: string,
): void {
  activeSessionsByClient.set(clientId, { workspaceId, sessionId })
}

export function getClientActiveSession(
  clientId: string,
  workspaceId: string,
): string | null {
  const active = activeSessionsByClient.get(clientId)
  return active?.workspaceId === workspaceId ? active.sessionId : null
}

export function clearClientActiveSession(clientId: string): void {
  activeSessionsByClient.delete(clientId)
}

export function unbindClientActiveSession(clientId: string, sessionId: string): void {
  const active = activeSessionsByClient.get(clientId)
  if (active?.sessionId === sessionId) activeSessionsByClient.delete(clientId)
}
