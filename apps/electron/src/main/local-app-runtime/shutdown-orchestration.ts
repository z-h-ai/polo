export interface LocalAppRuntimeShutdownOwner {
  shutdown(): Promise<void>
}

export interface LocalAppRuntimeShutdownOwners {
  coordinator?: LocalAppRuntimeShutdownOwner
  manager?: LocalAppRuntimeShutdownOwner
  scopedRegistry?: LocalAppRuntimeShutdownOwner
}

/**
 * Unified quit-time teardown orchestration: the coordinator runs FIRST
 * (revoke → abort → bounded cleanup lane → exact-generation stop), then the
 * manager and scoped registry ALWAYS run their forced cleanup (graceful
 * stop → SIGKILL force → managed-process retry) — a coordinator failure is
 * captured, never allowed to skip downstream forced cleanup, and every
 * failure is aggregated into the final rejection so no report is lost.
 */
export async function shutdownLocalAppRuntimeOwners(
  owners: LocalAppRuntimeShutdownOwners,
): Promise<void> {
  // Capture (never propagate) the coordinator failure: its exact-stop
  // rejections must not become the element that skips the manager/registry
  // forced cleanup below.
  const coordinatorFailure = await owners.coordinator?.shutdown().then(
    () => undefined,
    (error: unknown) => error,
  )
  const results = await Promise.allSettled([
    owners.manager?.shutdown(),
    owners.scopedRegistry?.shutdown(),
  ])
  const failures: unknown[] = [
    ...(coordinatorFailure !== undefined ? [coordinatorFailure] : []),
    ...results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : []),
  ]
  if (failures.length === 1) throw failures[0]!
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Failed to fully shut down the local app runtime lifecycle owners',
    )
  }
}
