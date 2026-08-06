#!/usr/bin/env bun

import { dlopen, FFIType } from 'bun:ffi'

const [, , source, destination] = process.argv
if (!source || !destination) {
  process.stderr.write('usage: atomic-rename-no-replace SOURCE DESTINATION\n')
  process.exit(64)
}

const cString = (value: string) => Buffer.from(`${value}\0`)
const AT_FDCWD = -100
let result = -1

if (process.platform === 'linux') {
  let library: ReturnType<typeof dlopen> | undefined
  for (const name of ['libc.so.6', 'libc.so']) {
    try {
      library = dlopen(name, {
        renameat2: {
          args: [
            FFIType.i32,
            FFIType.cstring,
            FFIType.i32,
            FFIType.cstring,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      })
      break
    }
    catch {
      // Try the next standard libc name.
    }
  }
  if (!library) {
    process.stderr.write('Polo could not load the Linux atomic rename primitive.\n')
    process.exit(69)
  }
  result = library.symbols.renameat2(
    AT_FDCWD,
    cString(source),
    AT_FDCWD,
    cString(destination),
    1, // RENAME_NOREPLACE
  )
  library.close()
}
else if (process.platform === 'darwin') {
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    renameatx_np: {
      args: [
        FFIType.i32,
        FFIType.cstring,
        FFIType.i32,
        FFIType.cstring,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
  })
  result = library.symbols.renameatx_np(
    AT_FDCWD,
    cString(source),
    AT_FDCWD,
    cString(destination),
    0x00000004, // RENAME_EXCL
  )
  library.close()
}
else {
  process.stderr.write(`Polo atomic rename is unsupported on ${process.platform}.\n`)
  process.exit(69)
}

if (result !== 0) {
  process.exit(73)
}
