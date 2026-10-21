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
    const encoded = encodeRpcErrorCodeInMessage('kb_service_unavailable', 'The knowledge base service is temporarily unavailable')
    expect(encoded).not.toBe('The knowledge base service is temporarily unavailable')
    expect(decodeRpcErrorCodeFromMessage(encoded)).toBe('kb_service_unavailable')
    expect(stripRpcErrorCodeFromMessage(encoded)).toBe('The knowledge base service is temporarily unavailable')
  })

  it('keeps the original text recoverable when the message itself contains separator-like text', () => {
    const encoded = encodeRpcErrorCodeInMessage('kb_conflict', 'changed under you: v2 > v1')
    expect(decodeRpcErrorCodeFromMessage(encoded)).toBe('kb_conflict')
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
    expect(decodeRpcErrorCodeFromMessage(`see ${encodeRpcErrorCodeInMessage('kb_conflict', 'x')}`)).toBeNull()
  })

  it('reads a live code property first, then the message marker', () => {
    expect(readRpcErrorCode(Object.assign(new Error('plain'), { code: 'kb_manage_required' }))).toBe('kb_manage_required')
    expect(readRpcErrorCode(new Error(encodeRpcErrorCodeInMessage('kb_space_read_only', 'read only')))).toBe('kb_space_read_only')
    // Live property wins when both are present.
    expect(readRpcErrorCode(Object.assign(
      new Error(encodeRpcErrorCodeInMessage('kb_conflict', 'message says conflict')),
      { code: 'kb_invalid_transition' },
    ))).toBe('kb_invalid_transition')
    expect(readRpcErrorCode(new Error('no code anywhere'))).toBeNull()
  })

  it('rewrites a coded error into a bridge-carriable Error that keeps the code property', () => {
    const source = Object.assign(new Error('The knowledge base service is temporarily unavailable'), {
      code: 'kb_service_unavailable',
    })
    const bridged = toBridgeCarriableError(source)
    expect(bridged).toBeInstanceOf(Error)
    expect((bridged as { code?: string }).code).toBe('kb_service_unavailable')
    expect(decodeRpcErrorCodeFromMessage(bridged.message)).toBe('kb_service_unavailable')
    expect(stripRpcErrorCodeFromMessage(bridged.message)).toBe('The knowledge base service is temporarily unavailable')
  })

  it('passes an error without a code through unchanged — no other surface semantics move', () => {
    const source = new Error('Request timeout: kb.LIST_COLLECTIONS (30000ms)')
    expect(toBridgeCarriableError(source)).toBe(source)
    expect(toBridgeCarriableError('raw string failure').message).toBe('raw string failure')
  })
})
