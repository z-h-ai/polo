import {beforeEach,afterEach,expect,test} from 'bun:test'
import {RPC_CHANNELS} from '@polo-ai/shared/protocol'
import {SessionManager,createManagedSession} from '../../sessions/SessionManager'
import {registerSessionsHandlers} from './sessions'
import {setRuntimeActiveProductSpace,setRuntimeActiveProductSpaceAccount} from '../../runtime/product-space-executions'
import {setSyncTrustedProductSpaceAccountId,setTrustedProductSpaceAccountProvider} from './trusted-product-space-account'
let manager:any,handlers:Map<string,Function>,effects:number
const accountId='browser-account',productSpaceId='browser-space',sessionId='browser-session',workspaceId='browser-workspace'
const requestId='browser-action-exact-rpc',digest='original-digest'
const ctx={workspaceId,clientId:'owned-renderer',webContentsId:null,signal:new AbortController().signal}
beforeEach(()=>{setSyncTrustedProductSpaceAccountId(accountId);setRuntimeActiveProductSpaceAccount(accountId);setRuntimeActiveProductSpace(productSpaceId);setTrustedProductSpaceAccountProvider(async()=>accountId);manager=new SessionManager();effects=0;handlers=new Map();registerSessionsHandlers({handle:(channel:string,fn:Function)=>handlers.set(channel,fn)}as never,{sessionManager:manager,platform:{logger:{info(){},warn(){},error(){},debug(){}}}}as never);manager.sessions.set(sessionId,createManagedSession({id:sessionId,createdAt:1},{id:workspaceId,rootPath:'/tmp/poo113-rpc-owned',name:'Owned',createdAt:1}as never,{accountId,productSpaceId}));manager.pendingPermissionRequests.set(requestId,{sessionId,type:'browser_action',browserScope:{accountId,productSpaceId,sessionId,generation:1},actionDigest:digest});manager.browserActionAuthorizations.set(sessionId,{resolve:(_id:string,_scope:unknown,decision:any)=>{expect(decision.actionDigest).toBe(digest);effects++;return true}})})
afterEach(()=>{manager.sessions.clear()})
const respond=(context=ctx,options:unknown={browserActionDigest:digest,browserActionPhase:'awaiting_authorization'})=>handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION)!(context,sessionId,requestId,true,false,options)
test('production permission RPC carries exact browser digest/options to the Host once',async()=>{expect(await respond()).toBe(true);expect(effects).toBe(1);expect(await respond()).toBe(false);expect(effects).toBe(1)})
test('another workspace cannot consume the original browser request',async()=>{await expect(respond({...ctx,workspaceId:'other'})).rejects.toThrow();expect(effects).toBe(0);expect(manager.pendingPermissionRequests.has(requestId)).toBe(true)})
test('an account replacement cannot consume a late approval',async()=>{setSyncTrustedProductSpaceAccountId('replacement');await expect(respond()).rejects.toThrow();expect(effects).toBe(0)})
test('missing or changed browser digest is denied without legacy fallback',async()=>{expect(await respond(ctx,{})).toBe(false);expect(await respond(ctx,{browserActionDigest:'other'})).toBe(false);expect(effects).toBe(0)})
