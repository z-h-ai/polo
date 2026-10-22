import { afterEach, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { AdminClient } from '../client.ts'
import { SkillTurnReceiptSchema, type SkillTurnReceipt } from '../skill-turn-contract.ts'
const original = globalThis.fetch
afterEach(() => { globalThis.fetch = original })
const accountId = randomUUID(), productSpaceId = randomUUID()
const request = { contractVersion: 1 as const, turnId: randomUUID(), subjectKind: 'personal_artifact' as const, subjectId: randomUUID(), versionId: randomUUID(), checksum: `sha256:${'a'.repeat(64)}` }
function receipt(delta: Partial<SkillTurnReceipt> = {}) { return SkillTurnReceiptSchema.parse({ ...request, receiptId: randomUUID(), accountId, productSpaceId, version: '1.0.0', state: 'active', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', ...delta }) }
function wire(body: unknown, inspect?: (url: string, init: RequestInit) => void) { globalThis.fetch = (async (url, init) => { inspect?.(String(url), init ?? {}); return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }) }) as typeof fetch }
it('begin sends generated strict contract using original actor bearer and exact ProductSpace', async () => {
 wire(receipt(), (url, init) => { expect(url).toBe(`https://admin.example/api/product-spaces/${productSpaceId}/skills/turns`); expect(JSON.parse(String(init.body))).toEqual(request); expect((init.headers as Record<string,string>).Authorization).toBe('Bearer original-session') })
 expect((await new AdminClient('https://admin.example').beginSkillTurn('original-session', accountId, productSpaceId, request)).versionId).toBe(request.versionId)
})
for (const [field, value] of Object.entries({ accountId: randomUUID(), productSpaceId: randomUUID(), turnId: randomUUID(), subjectId: randomUUID(), versionId: randomUUID(), checksum: `sha256:${'b'.repeat(64)}`, state: 'finished', expiresAt: '2000-01-01T00:00:00.000Z' })) it(`begin rejects changed ${field}`, async () => {
 wire(receipt({ [field]: value }))
 await expect(new AdminClient('https://admin.example').beginSkillTurn('original', accountId, productSpaceId, request)).rejects.toMatchObject({errorCode:'SERVER_ERROR'})
})
it('authorize/finish preserve the immutable original receipt and operation contract', async () => {
 const pin = receipt(), client = new AdminClient('https://admin.example')
 wire(pin, (url, init) => { expect(url).toEndWith(`/${pin.receiptId}/authorize`); expect(JSON.parse(String(init.body))).toEqual({contractVersion:1,turnId:pin.turnId}) })
 expect(await client.operateSkillTurn('original', pin, 'authorize')).toEqual(pin)
 wire({ ...pin, state:'finished' }); expect((await client.operateSkillTurn('original', pin, 'finish')).state).toBe('finished')
 wire({ ...pin, receiptId:randomUUID() }); await expect(client.operateSkillTurn('original', pin, 'authorize')).rejects.toMatchObject({errorCode:'SERVER_ERROR'})
 wire({ ...pin, expiresAt:'2031-01-01T00:00:00.000Z' }); await expect(client.operateSkillTurn('original', pin, 'authorize')).rejects.toMatchObject({errorCode:'SERVER_ERROR'})
})
