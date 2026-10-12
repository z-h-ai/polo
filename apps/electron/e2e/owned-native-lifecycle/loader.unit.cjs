'use strict';
// Unit fixtures only: simulated Electron identity/readiness; loopback control
// server exercises the loader's own protocol. No production Main or TRL claims.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const adapter = require('./loader.cjs');
const nonce = 'UNIT-owned-lifecycle-nonce';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(mode = 'FAULT', register = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-native-lifecycle-unit-')));
  const launch = 'a'.repeat(32);
  const directory = path.join(root, 'native-launches', launch);
  fs.mkdirSync(directory, {recursive: true});
  const intent = {resource_nonce: nonce, launch_id: launch, launch_nonce: 'UNIT-'+'x'.repeat(32), purpose: mode === 'DIRECT' ? 'direct-baseline' : 'fault-cold-read', mode, directory};
  adapter.privateWrite(path.join(directory, 'intent.private.json'), intent);
  adapter.privateWrite(path.join(root, 'native-launch-intent.private.json'), intent);
  for (const file of ['gate-core.cjs','evidence-writer.cjs']) fs.writeFileSync(path.join(root,file),'// unit dependency');
  fs.writeFileSync(path.join(root,'proxy.cjs'), `
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
exports.startProxy=async({secretFile})=>{
 exports.started=true;
 if(exports.pending) await exports.pending;
 const dir=path.dirname(secretFile), calls=[];
 const second=http.createServer((req,res)=>res.end('{}'));
 await new Promise(resolve=>second.listen(0,'127.0.0.1',resolve));
 const secondPort=second.address().port;
 const server=http.createServer((req,res)=>{calls.push(req.url);req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const native=JSON.parse(fs.readFileSync(path.join(dir,'native-registration.private.json')));
 const registration={...native,listeners:[{pid:process.pid,fd:'UNIT-fd1',host:'127.0.0.1',port,protocol:'TCP',state:'LISTEN'},{pid:process.pid,fd:'UNIT-fd2',host:'127.0.0.1',port:secondPort,protocol:'TCP',state:'LISTEN'}]};
 fs.writeFileSync(path.join(dir,'listeners-registration.private.json'),JSON.stringify(registration),{mode:0o600});
 return {proxyPort:secondPort,controlPort:port, calls, close:()=>new Promise(resolve=>server.close(()=>second.close(()=>{exports.closed=true;resolve();})))};
};
`);
  // Registrations here are synthetic unit identity facts, never native lsof proof.
  const proxy = path.join(root,'proxy.cjs');
  fs.writeFileSync(path.join(root,'wrapper.cjs'), `exports.installPortRegistrationWrapper=(ipc,h)=>{ipc.calls=h.calls;ipc.installed=true;return {removeRegistrationIntercept(){ipc.installed=false;}}};`);
  const ref = file => ({path: file, sha256: hash(file)});
  fs.mkdirSync(path.join(root,'electron'));
  const loaded_bundles = {};
  for (const [role,name] of Object.entries({main_bundle:'main.cjs',preload_bundle:'bootstrap-preload.cjs',browser_toolbar_bundle:'browser-toolbar-preload.cjs'})) {
    fs.writeFileSync(path.join(root,'electron',name),'// unit immutable bundle');
    loaded_bundles[role]=ref(path.join(root,'electron',name));
  }
  fs.writeFileSync(path.join(root,'renderer.json'),'{}');
  const config = {owned_root:root,resource_nonce:nonce,allowed_purposes:[intent.purpose],timeout_seconds:1,loader:ref(path.join(__dirname,'loader.cjs')),proxy:ref(proxy),port_wrapper:ref(path.join(root,'wrapper.cjs')),gate_core:ref(path.join(root,'gate-core.cjs')),evidence_writer:ref(path.join(root,'evidence-writer.cjs')),loaded_bundles,main_sha256:loaded_bundles.main_bundle.sha256,preload_sha256:loaded_bundles.preload_bundle.sha256,renderer_manifest:ref(path.join(root,'renderer.json')),renderer_manifest_sha256:hash(path.join(root,'renderer.json')),client_head:'UNIT-head',binding_file:{sha256:'UNIT-binding'},startup_arm_next:{'fault-cold-read':[{route:'UNIT-route'}]}};
  const configFile=path.join(root,'config.private.json'); adapter.privateWrite(configFile,config);
  if (register) {
    const native={...intent,native_resource_id:String(process.pid),native_pgid:process.pid,native_process_birth:'UNIT-birth',native_bundle_id:'UNIT.bundle',verified_runtime_binding:{client_head:config.client_head,main_sha256:config.main_sha256,preload_sha256:config.preload_sha256,renderer_manifest_sha256:config.renderer_manifest_sha256,binding_sha256:config.binding_file.sha256,helper_hashes:Object.fromEntries(['loader','proxy','port_wrapper','gate_core','evidence_writer'].map(k=>[k,config[k].sha256]))}};
    adapter.privateWrite(path.join(directory,'native-registration.private.json'),native);
    adapter.privateWrite(path.join(directory,'secret.private.json'),{launch_id:intent.launch_id,launch_nonce:intent.launch_nonce,purpose:intent.purpose,nonce,native_pid:process.pid,process_birth:native.native_process_birth,native_resource_id:native.native_resource_id,secret:'UNIT-secret'});
  }
  let becomeReady;
  const originalReady=new Promise(resolve=>becomeReady=resolve);
  const app={whenReady(){return originalReady;},once(){},exit(code){this.exitCode=code;}};
  return {root,directory,configFile,config,app,becomeReady,original:app.whenReady,ipcMain:{},clean(){fs.rmSync(root,{recursive:true,force:true});}};
}
async function runFixture(t,mode,register,callback) {
  const f=fixture(mode,register),old=process.env.TRL_EXECUTION_NONCE;
  process.env.TRL_EXECUTION_NONCE=nonce;
  try {await callback(f);} finally {if(old===undefined)delete process.env.TRL_EXECUTION_NONCE;else process.env.TRL_EXECUTION_NONCE=old;f.clean();}
}
test('DIRECT preserves immediate Main return and original readiness method',async t=>runFixture(t,'DIRECT',false,async f=>{
 let loaded=0;const result=adapter.start({...f,electron:{app:f.app},loadMain(){loaded++;return 'main';}});
 assert.equal(result,'main');assert.equal(loaded,1);assert.equal(f.app.whenReady,f.original);assert.equal(fs.existsSync(path.join(f.directory,'listeners.private.json')),false);
}));
test('FAULT loads Main synchronously before ready; bootstrap waits for arming and interception',async t=>runFixture(t,'FAULT',true,async f=>{
 let loaded=false,started=false;let bootstrap;
 const lifecycle=adapter.start({...f,electron:{app:f.app,ipcMain:f.ipcMain},loadMain(){loaded=true;bootstrap=f.app.whenReady().then(()=>{started=true;assert.equal(f.ipcMain.installed,true);assert.deepEqual(f.ipcMain.calls,['/mode','/arm-next']);});return 'main-result';}});
 try {
 assert.equal(loaded,true);assert.equal(started,false);f.becomeReady('ready-value');await Promise.resolve();await Promise.resolve();assert.equal(started,false);
 assert.equal(await lifecycle.ready,'main-result');await bootstrap;assert.equal(started,true);assert.equal(f.app.whenReady,f.original);assert.equal(f.app.exitCode,undefined);
 assert.equal(adapter.privateRead(path.join(f.directory,'ready.private.json')).main_loaded_synchronously,true);
 } finally {await lifecycle.shutdown();}
}));
test('FAULT owner timeout keeps already loaded Main bootstrap closed and restores readiness',async t=>runFixture(t,'FAULT',false,async f=>{
 let loaded=0,started=0;
 const lifecycle=adapter.start({...f,electron:{app:f.app},loadMain(){loaded++;f.app.whenReady().then(()=>started++);}});
 f.becomeReady();await lifecycle.ready;await Promise.resolve();assert.equal(loaded,1);assert.equal(started,0);assert.equal(f.app.exitCode,1);assert.equal(f.app.whenReady,f.original);assert.match(adapter.privateRead(path.join(f.directory,'error.private.json')).error,/readiness timed out/);assert.equal(fs.existsSync(path.join(f.directory,'ready.private.json')),false);
}));
test('synchronous Main failure restores method, exits owned app, never waits for owner',async t=>runFixture(t,'FAULT',false,async f=>{
 await adapter.start({...f,electron:{app:f.app},loadMain(){throw Error('UNIT-main-failure');}}).ready;
 assert.equal(f.app.whenReady,f.original);assert.equal(f.app.exitCode,1);assert.match(adapter.privateRead(path.join(f.directory,'error.private.json')).error,/UNIT-main-failure/);
}));
test('bundle drift rejects before Main executes',async t=>runFixture(t,'FAULT',false,async f=>{
 fs.appendFileSync(f.config.loaded_bundles.main_bundle.path,'drift');let loaded=0;
 assert.throws(()=>adapter.start({...f,electron:{app:f.app},loadMain(){loaded++;}}),/bundle drift/);assert.equal(loaded,0);assert.equal(f.app.whenReady,f.original);
}));
test('owner identity mismatch never admits bootstrap',async t=>runFixture(t,'FAULT',true,async f=>{
 const file=path.join(f.directory,'native-registration.private.json');const row=adapter.privateRead(file);row.native_pgid++;adapter.privateWrite(file,row);let started=0;
 const lifecycle=adapter.start({...f,electron:{app:f.app},loadMain(){f.app.whenReady().then(()=>started++);}});f.becomeReady();await lifecycle.ready;assert.equal(started,0);assert.equal(f.app.exitCode,1);assert.match(adapter.privateRead(path.join(f.directory,'error.private.json')).error,/PID/);
}));

test('shutdown interrupts owner wait without admitting captured bootstrap',async t=>runFixture(t,'FAULT',false,async f=>{
 let started=0;
 const lifecycle=adapter.start({...f,electron:{app:f.app},loadMain(){f.app.whenReady().then(()=>started++);}});
 f.becomeReady();await lifecycle.shutdown();assert.equal(started,0);assert.equal(f.app.whenReady,f.original);assert.equal(f.app.exitCode,1);assert.equal(fs.existsSync(path.join(f.directory,'listeners.private.json')),false);
}));
test('shutdown waits for pending proxy creation, closes its sockets, writes no listeners or ready',async t=>runFixture(t,'FAULT',true,async f=>{
 const proxy=require(f.config.proxy.path);let release;proxy.pending=new Promise(resolve=>release=resolve);let started=0;
 const lifecycle=adapter.start({...f,electron:{app:f.app,ipcMain:f.ipcMain},loadMain(){f.app.whenReady().then(()=>started++);}});
 f.becomeReady();while(!proxy.started)await new Promise(resolve=>setImmediate(resolve));
 let shutdownDone=false;const shutdown=lifecycle.shutdown().then(()=>shutdownDone=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(shutdownDone,false);
 release();await shutdown;assert.equal(shutdownDone,true);assert.equal(proxy.closed,true);assert.equal(started,0);assert.equal(fs.existsSync(path.join(f.directory,'listeners.private.json')),false);assert.equal(fs.existsSync(path.join(f.directory,'ready.private.json')),false);
}));
test('changed readiness method fails closed without success receipt and still closes sockets',async t=>runFixture(t,'FAULT',true,async f=>{
 const proxy=require(f.config.proxy.path);let started=0;
 const lifecycle=adapter.start({...f,electron:{app:f.app,ipcMain:f.ipcMain},loadMain(){f.app.whenReady().then(()=>started++);f.app.whenReady=()=>Promise.resolve();}});
 f.becomeReady();await lifecycle.ready;assert.equal(started,0);assert.equal(proxy.closed,true);assert.equal(f.app.exitCode,1);assert.equal(fs.existsSync(path.join(f.directory,'ready.private.json')),false);assert.match(adapter.privateRead(path.join(f.directory,'error.private.json')).error,/barrier changed/);
}));
