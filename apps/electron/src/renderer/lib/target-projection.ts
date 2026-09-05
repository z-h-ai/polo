/**
 * Target-projection readiness coordination for committed space switches.
 *
 * A committed switch remounts the whole shell and every projection
 * (sessions, skills, sources, files, permissions) reloads under the new
 * context. The sessions loader owns the auto reverse-transaction; the other
 * loaders report their failures through this channel so the App can run the
 * same trusted rollback no matter WHICH target projection failed — a switch
 * never settles into a half-loaded ready shell.
 */

const TARGET_PROJECTION_FAILURE_EVENT = 'polo:target-projection-failure'

export interface TargetProjectionFailure {
  source: 'skills' | 'sources' | 'sessions' | 'files' | 'permissions'
  message?: string
}

export function reportTargetProjectionFailure(
  failure: TargetProjectionFailure,
): void {
  window.dispatchEvent(new CustomEvent<TargetProjectionFailure>(
    TARGET_PROJECTION_FAILURE_EVENT,
    { detail: failure },
  ))
}

export function onTargetProjectionFailure(
  listener: (failure: TargetProjectionFailure) => void,
): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<TargetProjectionFailure>).detail)
  }
  window.addEventListener(TARGET_PROJECTION_FAILURE_EVENT, handleEvent)
  return () => window.removeEventListener(TARGET_PROJECTION_FAILURE_EVENT, handleEvent)
}
