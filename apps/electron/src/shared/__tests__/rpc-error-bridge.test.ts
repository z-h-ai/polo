import { describe, expect, it } from 'bun:test'
import {
  decodeRpcErrorCodeFromMessage,
  encodeRpcErrorCodeInMessage,
  readRpcErrorCode,
  stripRpcErrorCodeFromMessage,
  toBridgeCarriableError,
} from '../rpc-error-bridge'

/**
 * POO-108 F2: the context bridge re-creates a rejected native Error in the
 * renderer from its MESSAGE alone — `code` never survives the crossing. These
 * tests pin the message-carriage contract the bridge layer and the renderer's
 * KB error mapping both rely on.
 */

describe('rpc-error-bridge message carriage', () => {
  it('roundtrips a coded message', () => {
    const encoded = encodeRpcErrorCodeInMessage('pc_library_not_ready', 'The project library is not ready yet')
    expect(encoded).not.toBe('The project library is not ready yet')
    expect(decodeRpcErrorCodeFromMessage(encoded)).toBe('pc_library_not_ready')
    expect(stripRpcErrorCodeFromMessage(encoded)).toBe('The project library is not ready yet')
  })

  it('keeps the original text recoverable when the message itself contains separator-like text', () => {
    const encoded = encodeRpcErrorCodeInMessage('pc_revision_conflict', 'changed under you: v2 > v1')
    expect(decodeRpcErrorCodeFromMessage(encoded)).toBe('pc_revision_conflict')
    expect(stripRpcErrorCodeFromMessage(encoded)).toBe('changed under you: v2 > v1')
  })

  it('answers null for plain messages and degenerate markers', () => {
    expect(decodeRpcErrorCodeFromMessage('plain failure')).toBeNull()
    expect(decodeRpcErrorCodeFromMessage(undefined)).toBeNull()
    expect(decodeRpcErrorCodeFromMessage(null)).toBeNull()
    // A marker with no code is not a code.
    expect(decodeRpcErrorCodeFromMessage('polo-rpc-code:')).toBeNull()
    expect(decodeRpcErrorCodeFromMessage('polo-rpc-code::tail')).toBeNull()
    // A marker mentioned mid-message is not a marker head.
    expect(decodeRpcErrorCodeFromMessage(`see ${encodeRpcErrorCodeInMessage('pc_revision_conflict', 'x')}`)).toBeNull()
  })

  it('reads a live code property first, then the message marker', () => {
    expect(readRpcErrorCode(Object.assign(new Error('plain'), { code: 'pc_forbidden' }))).toBe('pc_forbidden')
    expect(readRpcErrorCode(new Error(encodeRpcErrorCodeInMessage('pc_read_only', 'read only')))).toBe('pc_read_only')
    // Live property wins when both are present.
    expect(readRpcErrorCode(Object.assign(
      new Error(encodeRpcErrorCodeInMessage('pc_revision_conflict', 'message says conflict')),
      { code: 'pc_validation_error' },
    ))).toBe('pc_validation_error')
    expect(readRpcErrorCode(new Error('no code anywhere'))).toBeNull()
  })

  it('rewrites a coded error into a bridge-carriable Error that keeps the code property', () => {
    const source = Object.assign(new Error('The project library is not ready yet'), {
      code: 'pc_library_not_ready',
    })
    const bridged = toBridgeCarriableError(source)
    expect(bridged).toBeInstanceOf(Error)
    expect((bridged as { code?: string }).code).toBe('pc_library_not_ready')
    expect(decodeRpcErrorCodeFromMessage(bridged.message)).toBe('pc_library_not_ready')
    expect(stripRpcErrorCodeFromMessage(bridged.message)).toBe('The project library is not ready yet')
  })

  it('passes an error without a code through unchanged — no other surface semantics move', () => {
    const source = new Error('Request timeout: pc.LIST_CAPABILITIES (30000ms)')
    expect(toBridgeCarriableError(source)).toBe(source)
    expect(toBridgeCarriableError('raw string failure').message).toBe('raw string failure')
  })
})
