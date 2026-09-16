/**
 * Terminal onboarding is a recoverable convenience step. Keep its exception
 * boundary local so credential checks, power management, telemetry, updates,
 * and deep-link handling always continue.
 */
export async function runNonCriticalTerminalOnboarding(
  runOnboarding: () => Promise<unknown>,
  logError: (error: unknown) => void,
): Promise<void> {
  try {
    await runOnboarding()
  } catch (error) {
    logError(error)
  }
}
