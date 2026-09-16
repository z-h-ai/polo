import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, openSync } from 'node:fs';

import koffi from 'koffi';

const POSIX_LOCK_EXCLUSIVE = 2;
const POSIX_LOCK_NONBLOCKING = 4;
const POSIX_LOCK_UNLOCK = 8;

const WINDOWS_WAIT_OBJECT_0 = 0x00000000;
const WINDOWS_WAIT_ABANDONED = 0x00000080;
const WINDOWS_WAIT_TIMEOUT = 0x00000102;
const WINDOWS_WAIT_FAILED = 0xffffffff;

export interface NativeCredentialWriteLockOptions {
  timeoutMs: number;
  retryMs: number;
}

export interface NativeCredentialWriteLockHandle {
  release(): void;
}

interface PosixFunctions {
  flock(fd: number, operation: number): number;
}

interface WindowsFunctions {
  createMutex(attributes: null, initialOwner: boolean, name: string): unknown;
  waitForSingleObject(handle: unknown, milliseconds: number): number;
  releaseMutex(handle: unknown): boolean;
  closeHandle(handle: unknown): boolean;
  getLastError(): number;
}

let posixFunctions: PosixFunctions | undefined;
let windowsFunctions: WindowsFunctions | undefined;

function getPosixFunctions(): PosixFunctions {
  if (posixFunctions) return posixFunctions;
  const library = koffi.load(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6');
  const flock = library.func('int flock(int fd, int operation)') as PosixFunctions['flock'];
  posixFunctions = { flock };
  return posixFunctions;
}

function getWindowsFunctions(): WindowsFunctions {
  if (windowsFunctions) return windowsFunctions;
  const kernel32 = koffi.load('kernel32.dll');
  windowsFunctions = {
    createMutex: kernel32.func(
      '__stdcall',
      'CreateMutexW',
      'void *',
      ['void *', 'bool', 'str16'],
    ) as WindowsFunctions['createMutex'],
    waitForSingleObject: kernel32.func(
      '__stdcall',
      'WaitForSingleObject',
      'uint32',
      ['void *', 'uint32'],
    ) as WindowsFunctions['waitForSingleObject'],
    releaseMutex: kernel32.func(
      '__stdcall',
      'ReleaseMutex',
      'bool',
      ['void *'],
    ) as WindowsFunctions['releaseMutex'],
    closeHandle: kernel32.func(
      '__stdcall',
      'CloseHandle',
      'bool',
      ['void *'],
    ) as WindowsFunctions['closeHandle'],
    getLastError: kernel32.func(
      '__stdcall',
      'GetLastError',
      'uint32',
      [],
    ) as WindowsFunctions['getLastError'],
  };
  return windowsFunctions;
}

function tryAcquirePosixLock(lockPath: string): NativeCredentialWriteLockHandle | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`Unsupported POSIX credential lock platform: ${process.platform}`);
  }
  const descriptor = openSync(lockPath, 'a+', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    const { flock } = getPosixFunctions();
    if (flock(descriptor, POSIX_LOCK_EXCLUSIVE | POSIX_LOCK_NONBLOCKING) === 0) {
      let active = true;
      return {
        release(): void {
          if (!active) return;
          active = false;
          try {
            if (flock(descriptor, POSIX_LOCK_UNLOCK) !== 0) {
              throw new Error(`Could not release native credential lock (errno ${koffi.errno()})`);
            }
          } finally {
            closeSync(descriptor);
          }
        },
      };
    }
    const errno = koffi.errno();
    const retryable = new Set([
      koffi.os.errno.EAGAIN,
      koffi.os.errno.EWOULDBLOCK,
      koffi.os.errno.EINTR,
    ]);
    if (retryable.has(errno)) {
      closeSync(descriptor);
      return null;
    }
    throw new Error(`Could not acquire native credential lock (errno ${errno})`);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    throw error;
  }
}

function windowsMutexName(lockPath: string): string {
  const hash = createHash('sha256').update(lockPath).digest('hex');
  return `Local\\PoloCredentialWrite-${hash}`;
}

function tryAcquireWindowsLock(lockPath: string): NativeCredentialWriteLockHandle | null {
  const functions = getWindowsFunctions();
  const handle = functions.createMutex(null, false, windowsMutexName(lockPath));
  if (!handle) {
    throw new Error(`CreateMutexW failed with Windows error ${functions.getLastError()}`);
  }
  const result = functions.waitForSingleObject(handle, 0);
  if (result === WINDOWS_WAIT_OBJECT_0 || result === WINDOWS_WAIT_ABANDONED) {
    let active = true;
    return {
      release(): void {
        if (!active) return;
        active = false;
        try {
          if (!functions.releaseMutex(handle)) {
            throw new Error(`ReleaseMutex failed with Windows error ${functions.getLastError()}`);
          }
        } finally {
          functions.closeHandle(handle);
        }
      },
    };
  }
  functions.closeHandle(handle);
  if (result === WINDOWS_WAIT_TIMEOUT) return null;
  if (result === WINDOWS_WAIT_FAILED) {
    throw new Error(`WaitForSingleObject failed with Windows error ${functions.getLastError()}`);
  }
  throw new Error(`WaitForSingleObject returned unexpected result ${result}`);
}

function tryAcquireNativeLock(lockPath: string): NativeCredentialWriteLockHandle | null {
  return process.platform === 'win32'
    ? tryAcquireWindowsLock(lockPath)
    : tryAcquirePosixLock(lockPath);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export async function acquireNativeCredentialWriteLock(
  lockPath: string,
  options: NativeCredentialWriteLockOptions,
): Promise<NativeCredentialWriteLockHandle> {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const lock = tryAcquireNativeLock(lockPath);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new Error('Timed out acquiring shared credential write lock');
    }
    await new Promise(resolve => setTimeout(resolve, options.retryMs));
  }
}

export function acquireNativeCredentialWriteLockSync(
  lockPath: string,
  options: NativeCredentialWriteLockOptions,
): NativeCredentialWriteLockHandle {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const lock = tryAcquireNativeLock(lockPath);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new Error('Timed out acquiring shared credential write lock');
    }
    sleepSync(options.retryMs);
  }
}
