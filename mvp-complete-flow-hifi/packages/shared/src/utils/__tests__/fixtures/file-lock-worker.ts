import {
  closeSync,
  existsSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { withCrossProcessFileLockSync } from '../../files'

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds)
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function waitFor(path: string): void {
  while (!existsSync(path)) sleepSync(5)
}

const lockDir = required('POLO_LOCK_DIR')
const label = required('POLO_LOCK_LABEL')
const enteredPath = required('POLO_LOCK_ENTERED')
const exitedPath = required('POLO_LOCK_EXITED')
const releasePath = required('POLO_LOCK_RELEASE')
const beforePublishPath = process.env.POLO_LOCK_BEFORE_PUBLISH
const releasePublishPath = process.env.POLO_LOCK_RELEASE_PUBLISH
const beforeRecoveryPublishPath = process.env.POLO_LOCK_BEFORE_RECOVERY_PUBLISH
const releaseRecoveryPublishPath = process.env.POLO_LOCK_RELEASE_RECOVERY_PUBLISH
const recoveryPath = process.env.POLO_LOCK_RECOVERY
const releaseRecoveryPath = process.env.POLO_LOCK_RELEASE_RECOVERY
const quarantinedPath = process.env.POLO_LOCK_QUARANTINED
const releaseQuarantinePath = process.env.POLO_LOCK_RELEASE_QUARANTINE
const criticalGuardPath = process.env.POLO_LOCK_CRITICAL_GUARD

withCrossProcessFileLockSync(
  lockDir,
  () => {
    let guardFd: number | undefined
    if (criticalGuardPath) {
      guardFd = openSync(criticalGuardPath, 'wx', 0o600)
      writeFileSync(guardFd, label)
    }
    try {
      writeFileSync(enteredPath, label)
      waitFor(releasePath)
      writeFileSync(exitedPath, label)
    } finally {
      if (guardFd !== undefined) closeSync(guardFd)
      if (criticalGuardPath) rmSync(criticalGuardPath, { force: true })
    }
  },
  20_000,
  {
    beforePublish: beforePublishPath && releasePublishPath
      ? () => {
          writeFileSync(beforePublishPath, label)
          waitFor(releasePublishPath)
        }
      : undefined,
    beforeRecoveryClaimPublish: beforeRecoveryPublishPath && releaseRecoveryPublishPath
      ? () => {
          writeFileSync(beforeRecoveryPublishPath, label)
          waitFor(releaseRecoveryPublishPath)
        }
      : undefined,
    afterRecoveryClaimPublished: recoveryPath && releaseRecoveryPath
      ? () => {
          writeFileSync(recoveryPath, label)
          waitFor(releaseRecoveryPath)
        }
      : undefined,
    afterLockQuarantined: quarantinedPath && releaseQuarantinePath
      ? () => {
          writeFileSync(quarantinedPath, label)
          waitFor(releaseQuarantinePath)
        }
      : undefined,
  },
)
