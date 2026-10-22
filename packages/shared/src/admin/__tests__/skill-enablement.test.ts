import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AdminClient } from '../client.ts'
import { ArtifactInstanceIdSchema, ProductSpaceSummarySchema, parseProductSpaceCatalogResponseForProductSpace } from '../../product-spaces/index.ts'

const personal = ProductSpaceSummarySchema.parse({id:'space-p',kind:'personal',name:'我的空间',accessMode:'active',payer:{kind:'account'}})
const enterprise = ProductSpaceSummarySchema.parse({id:'space-e',kind:'enterprise',enterpriseId:'enterprise-e',name:'Enterprise',role:'member',accessMode:'active',payer:{kind:'enterprise',enterpriseId:'enterprise-e'}})
const id = ArtifactInstanceIdSchema.parse('skill-k')
const assistant = {kind:'built_in_app',builtInAppId:'polo_assistant',catalogEntryId:'assistant',name:'Polo',description:'',availability:'available'}
function dto(context=personal, enabled=false, present=true) {
 return {contractVersion:1,productSpaceId:context.id,catalogRevision:'fresh-r2',entries:[assistant,...(present?[{kind:'skill',artifactInstanceId:id,catalogEntryId:'entry-k',name:'Research',description:'Research',availability:'available',enabled,version:{versionId:'version-k',version:'1.0.0'},sources:context.kind==='personal'?[{kind:'creator_circle',circleId:'circle-c',name:'Circle'}]:[{kind:'enterprise_import',name:'Enterprise'}],permissions:[]}]:[])]}
}
let original: typeof fetch
let calls: Array<{url:string;init:RequestInit}>
beforeEach(()=>{ original=globalThis.fetch;calls=[] })
afterEach(()=>{ globalThis.fetch=original })
function responses(bodies: Array<unknown>, statuses:number[]=[]) {
 globalThis.fetch=(async(input,init)=>{
  calls.push({url:String(input),init:init??{}})
  const i=calls.length-1,status=statuses[i]??200
  return new Response(status===304?null:JSON.stringify(bodies[i]),{status,headers:{'Content-Type':'application/json'}})
 }) as typeof fetch
}
function mutation(context=personal,enabled=true) {return {contractVersion:1,productSpaceId:context.id,artifactInstanceId:id,enabled,catalogRevision:'refresh_full_catalog:not-entry-binding'}}

describe('Canonical member Skill enablement consumer',()=>{
 for(const context of [personal,enterprise]) test(`enables ${context.kind} then reads a revisionless full Catalog`,async()=>{
  responses([mutation(context),dto(context,true)])
  const old=parseProductSpaceCatalogResponseForProductSpace(dto(context),context)
  const result=await new AdminClient('https://admin.example.com').setProductSpaceSkillEnablement('member-bearer',context,old,id,true,new Set([id]))
  expect(result.catalog.entries.find(e=>e.kind==='skill')?.enabled).toBe(true)
  expect(calls.map(x=>x.init.method)).toEqual(['PUT','GET'])
  expect(calls[0]!.url).toBe(`https://admin.example.com/api/product-spaces/${context.id}/skills/${id}/enablement`)
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({enabled:true})
  expect(calls[1]!.url).toBe(`https://admin.example.com/api/product-spaces/${context.id}/catalog`)
  expect(calls[1]!.url).not.toContain('revision=')
  expect((calls[0]!.init.headers as Record<string,string>).Authorization).toBe('Bearer member-bearer')
 })
 test('a concurrent opposite write is observed rather than echoed as enabled',async()=>{
  responses([mutation(personal,false),dto(personal,false)])
  const result=await new AdminClient('https://admin.example.com').setProductSpaceSkillEnablement('member',personal,parseProductSpaceCatalogResponseForProductSpace(dto(),personal),id,true,new Set([id]))
  expect(result.mutation.enabled).toBe(false)
  expect(result.catalog.entries.find(e=>e.kind==='skill')?.enabled).toBe(false)
 })
 test('disable after withdrawal uses only the previously trusted exact tuple',async()=>{
  responses([mutation(personal,false),dto(personal,false,false)])
  const result=await new AdminClient('https://admin.example.com').setProductSpaceSkillEnablement('member',personal,undefined,id,false,new Set([id]))
  expect(result.catalog.entries.some(e=>e.kind==='skill')).toBe(false)
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({enabled:false})
 })
 test('fabricated disable or unavailable enable emits no request',async()=>{
  const client=new AdminClient('https://admin.example.com')
  await expect(client.setProductSpaceSkillEnablement('member',personal,undefined,id,false,new Set())).rejects.toMatchObject({errorCode:'FORBIDDEN'})
  await expect(client.setProductSpaceSkillEnablement('member',personal,parseProductSpaceCatalogResponseForProductSpace(dto(personal,false,false),personal),id,true,new Set([id]))).rejects.toMatchObject({errorCode:'FORBIDDEN'})
  expect(calls).toHaveLength(0)
 })
 test('cross-space mutation response fails before Catalog hydration',async()=>{
  responses([mutation(enterprise)])
  await expect(new AdminClient('https://admin.example.com').setProductSpaceSkillEnablement('member',personal,parseProductSpaceCatalogResponseForProductSpace(dto(),personal),id,true,new Set([id]))).rejects.toMatchObject({errorCode:'SERVER_ERROR'})
  expect(calls).toHaveLength(1)
 })
 test('a post-mutation 304 cannot bind the old entry set',async()=>{
  responses([mutation(),null],[200,304])
  await expect(new AdminClient('https://admin.example.com').setProductSpaceSkillEnablement('member',personal,parseProductSpaceCatalogResponseForProductSpace(dto(),personal),id,true,new Set([id]))).rejects.toMatchObject({errorCode:'SERVER_ERROR'})
  expect(calls).toHaveLength(2)
 })
})
