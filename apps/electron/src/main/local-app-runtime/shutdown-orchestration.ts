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
  // Capture (never propagate) the coordinator failure by SETTLED STATUS:
  // its exact-stop rejections must not become the element that skips the
  // manager/registry forced cleanup below, and a rejection reason of
  // `undefined` (Promise.reject(undefined)) must still classify as a
  // failure — never by value-inspecting the captured error.
  let coordinatorFailure: unknown
  let coordinatorFailed = false
  if (owners.coordinator) {
    const [settledCoordinator] = await Promise.allSettled([
      owners.coordinator.shutdown(),
    ])
    if (settledCoordinator?.status === 'rejected') {
      coordinatorFailed = true
      coordinatorFailure = settledCoordinator.reason
    }
  }
  const results = await Promise.allSettled([
    owners.manager?.shutdown(),
    owners.scopedRegistry?.shutdown(),
  ])
  const failures: unknown[] = [
    ...(coordinatorFailed ? [coordinatorFailure] : []),
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
