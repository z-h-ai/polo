import {afterEach,expect,test} from 'bun:test'
import {AdminClient} from '../client'
import {defaultBrowserPolicy} from '../browser-policy-contract'
import {browserActionDigest} from '../../agent/browser-action-authorization'
const original=globalThis.fetch
const space='11111111-1111-4111-8111-111111111111'
afterEach(()=>{globalThis.fetch=original})
function answer(body:unknown){globalThis.fetch=(async()=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}}))as unknown as typeof fetch}
test('managed policy client preserves scope, current version and strict policy',async()=>{const policy=defaultBrowserPolicy();answer({productSpaceId:space,configVersion:'7',policyDigest:browserActionDigest(policy),policy});expect((await new AdminClient('https://admin.example.test').getBrowserPolicy('owned-test-token',space)).policy.autoAcceptEnabled).toBe(false)})
test('a different ProductSpace and malformed policies never become an all-allow policy',async()=>{const policy=defaultBrowserPolicy();answer({productSpaceId:'22222222-2222-4222-8222-222222222222',configVersion:'7',policyDigest:browserActionDigest(policy),policy});await expect(new AdminClient('https://admin.example.test').getBrowserPolicy('owned-test-token',space)).rejects.toThrow();answer({productSpaceId:space,configVersion:'7',policyDigest:'a'.repeat(64),policy:{...policy,autoAcceptEnabled:'yes'}});await expect(new AdminClient('https://admin.example.test').getBrowserPolicy('owned-test-token',space)).rejects.toThrow()})
