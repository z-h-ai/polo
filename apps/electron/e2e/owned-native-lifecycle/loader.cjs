'use strict';
// Canonical owned native fixture lifecycle. Import creates no resources or production Main.
// Historical loader lineage SHA256: 45c1a3596aae9f3b6cbbc92f7a928199317ec5b5a8dc2ee30912e1db50b7bcf1
// Generated copies are immutable per-run inputs; never edit old owner copies.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const PURPOSES = Object.freeze({'direct-baseline':'DIRECT','direct-phone-callback':'DIRECT','direct-restored':'DIRECT','fault-cold-read':'FAULT','fault-space-stale':'FAULT','fault-focus':'FAULT'});
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function privateRead(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid() || s.size > 1024 * 1024) throw Error('private native lifecycle ownership/mode/size mismatch');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function privateWrite(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function validateIntent(intent, config, root) {
  if (!/^[a-f0-9]{32}$/.test(intent.launch_id || '') || typeof intent.launch_nonce !== 'string' || intent.launch_nonce.length < 24 || intent.resource_nonce !== config.resource_nonce || PURPOSES[intent.purpose] !== intent.mode || !config.allowed_purposes.includes(intent.purpose)) throw Error('native launch intent nonce/purpose mismatch');
  const directory = fs.realpathSync(intent.directory);
  if (directory !== path.join(root, 'native-launches', intent.launch_id)) throw Error('native launch path outside exact owned root');
  const original = privateRead(path.join(directory, 'intent.private.json'));
  if (JSON.stringify(original) !== JSON.stringify(intent)) throw Error('native active intent differs from immutable per-launch intent');
  return directory;
}
function validateRegistration(registration, intent, pid, config) {
  if (registration.native_resource_id !== String(pid) || registration.native_pgid !== pid || !registration.native_process_birth || !registration.native_bundle_id) throw Error('actual native PID/birth/PGID/resource binding missing');
  for (const key of ['resource_nonce','launch_id','launch_nonce','purpose']) if (registration[key] !== intent[key]) throw Error('native registration launch binding differs: ' + key);
  if (config) {
    const proof=registration.verified_runtime_binding;
    if (!proof || proof.client_head!==config.client_head || proof.main_sha256!==config.main_sha256 || proof.preload_sha256!==config.preload_sha256 || proof.renderer_manifest_sha256!==config.renderer_manifest_sha256 || proof.binding_sha256!==config.binding_file.sha256) throw Error('actual owner source/bundle binding proof differs');
    for(const key of ['loader','proxy','port_wrapper','gate_core','evidence_writer']) if(proof.helper_hashes?.[key]!==config[key].sha256) throw Error('actual owner helper proof differs');
  }
}
function validateListeners(registration, native, ports) {
  for (const key of ['native_resource_id','native_process_birth','native_bundle_id','native_pgid','resource_nonce','launch_id','launch_nonce','purpose']) if (registration[key] !== native[key]) throw Error('listener parent native resource differs');
  if (!Array.isArray(registration.listeners) || registration.listeners.length !== 2 || new Set(registration.listeners.map(row => row.port)).size !== 2) throw Error('exact two listener registrations required');
  for (const row of registration.listeners) if (row.pid !== native.native_pgid || row.host !== '127.0.0.1' || row.protocol !== 'TCP' || row.state !== 'LISTEN' || !row.fd || !ports.includes(row.port)) throw Error('actual listener socket association differs');
}
async function waitPrivate(file, timeoutSeconds, signal) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (fs.existsSync(file)) return privateRead(file);
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 50);
      signal?.addEventListener('abort', onAbort, {once:true});
      if (signal?.aborted) onAbort();
    });
  }
  throw Error('bounded native owner readiness timed out: ' + file);
}
function control(port, secret, nonce, url, body) {
  // Calls the reviewed adapter's genuine control API, never a product endpoint.
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = http.request({host:'127.0.0.1',port,path:url,method:'POST',headers:{Authorization:'Bearer '+secret,'X-Fault-Nonce':nonce,'Content-Type':'application/json','Content-Length':bytes.length},timeout:5000}, res => {
      let size = 0; const chunks=[];
      res.on('data', b => {size+=b.length; if (size>8192) req.destroy(Error('owned control response too large')); else chunks.push(b);});
      res.on('end', () => {if (res.statusCode !== 200) reject(Error('owned fault control failed status='+res.statusCode)); else {try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch {reject(Error('invalid owned control response'));}}});
    });
    req.on('timeout',()=>req.destroy(Error('owned fault control timed out')));req.on('error',reject);req.end(bytes);
  });
}
function validateLoadedBundles(config, root) {
const names={main_bundle:'main.cjs',preload_bundle:'bootstrap-preload.cjs',browser_toolbar_bundle:'browser-toolbar-preload.cjs'};
if(Object.keys(config.loaded_bundles).sort().join()!==Object.keys(names).sort().join())throw Error('exact loaded three-bundle inventory required');
for(const [role,row] of Object.entries(config.loaded_bundles)) if(digest(row.path)!==row.sha256 || fs.realpathSync(row.path)!==path.join(root,'electron',names[role])) throw Error('actual loaded native bundle drift: '+role);
if(config.loaded_bundles.main_bundle.sha256!==config.main_sha256 || config.loaded_bundles.preload_bundle.sha256!==config.preload_sha256)throw Error('actual loaded Main/preload declared hashes differ');
if(digest(config.renderer_manifest.path)!==config.renderer_manifest.sha256)throw Error('actual renderer manifest drift');
}
// Main must execute before Electron ready (Sentry and privileged schemes), while
// its actual whenReady bootstrap waits for the real owner/fault admission.
function holdStartup(app) {
  const original = app.whenReady;
  const descriptor = Object.getOwnPropertyDescriptor(app, 'whenReady');
  if (typeof original !== 'function') throw Error('native app.whenReady missing');
  let admit;
  const admission = new Promise(resolve => { admit = resolve; });
  const wrapper = function (...args) {
    return Promise.resolve(original.apply(this, args)).then(value => admission.then(() => value));
  };
  app.whenReady = wrapper;
  if (app.whenReady !== wrapper) throw Error('native startup barrier installation failed');
  const restore = () => {
    if (app.whenReady !== wrapper) throw Error('native startup barrier changed before restoration');
    if (descriptor) Object.defineProperty(app, 'whenReady', descriptor);
    else delete app.whenReady;
  };
  let restored = false;
  return {
    check() { if (!restored && app.whenReady !== wrapper) throw Error('native startup barrier changed before restoration'); },
    restore() { if (!restored) { restore(); restored = true; } },
    release() { this.restore(); admit(); },
  };
}
function start({root, configFile, loadMain, electron}) {
  root = fs.realpathSync(root); const config = privateRead(configFile);
  if (fs.realpathSync(path.dirname(configFile)) !== root || config.owned_root !== root || config.resource_nonce !== process.env.TRL_EXECUTION_NONCE) throw Error('native lifecycle config owner/nonce mismatch');
  for (const key of ['loader','proxy','port_wrapper','gate_core','evidence_writer']) if (digest(config[key].path) !== config[key].sha256) throw Error('native reviewed helper bytes changed: '+key);
  if (fs.realpathSync(config.loader.path) !== fs.realpathSync(__filename) || !Number.isInteger(config.timeout_seconds) || config.timeout_seconds < 1 || config.timeout_seconds > 30) throw Error('native loader/readiness binding differs');
  if (path.resolve(config.proxy.path, '..', 'gate-core.cjs') !== path.resolve(config.gate_core.path)) throw Error('reviewed proxy/gate dependency binding differs');
  if (path.resolve(config.proxy.path, '..', 'evidence-writer.cjs') !== path.resolve(config.evidence_writer.path)) throw Error('reviewed evidence writer dependency binding differs');
  const intent = privateRead(path.join(root, 'native-launch-intent.private.json'));
  const directory = validateIntent(intent,config,root);const claim={...intent,pid:process.pid};
  privateWrite(path.join(directory,'claim.private.json'),claim);
  // DIRECT adds only lifecycle observation. Preserve original synchronous require,
  // original event/callback and complete real OS phone/cold URL behavior.
  if (intent.mode === 'DIRECT') return loadMain();
  validateLoadedBundles(config, root);
  const startup = holdStartup(electron.app);
  let harness; let proxyPending; let interception; let closing=false; let mainResult;
  let closePending; let ready;
  const cancellation = new AbortController();
  const assertOpen=()=>{if(closing)throw Error('native lifecycle owner shutdown during readiness');};
  // Shutdown waits for a pending proxy creation before closing its sockets.
  // Internal failure cleanup never awaits its own ready promise.
  const closeOwned=()=>{
    closing=true;
    cancellation.abort(Error('native lifecycle owner shutdown during readiness'));
    if (!closePending) closePending=(async()=>{
      let restoreError;
      try { startup.restore(); } catch(error) { restoreError=error; }
      try {
        if(proxyPending) { try { harness=await proxyPending; } catch { /* no harness created */ } }
        if(interception) { const current=interception;interception=undefined;current.removeRegistrationIntercept(); }
      } finally { if(harness) await harness.close(); }
      if(restoreError) throw restoreError;
    })();
    return closePending;
  };
  const shutdown=async()=>{await closeOwned();await ready;};
  const fail=async(error)=>{
    try { await closeOwned(); }
    finally {
      try {
        privateWrite(path.join(directory,'error.private.json'),{...claim,category:'native-lifecycle-infrastructure',error:String(error.message),native_execution_verified:false});
      } finally { electron.app.exit(1); }
    }
    throw error;
  };
  try { mainResult = loadMain(); }
  catch(error) { ready=fail(error).catch(()=>undefined);return {ready,shutdown}; }
  const run = async () => {
    try {
      const native = await waitPrivate(path.join(directory,'native-registration.private.json'),config.timeout_seconds,cancellation.signal);
      assertOpen();
      validateRegistration(native,intent,process.pid,config);
      if(closing)throw Error('native lifecycle owner shutdown during readiness');
      validateLoadedBundles(config, root);
      const secret = privateRead(path.join(directory,'secret.private.json'));
      if (secret.launch_id !== intent.launch_id || secret.launch_nonce !== intent.launch_nonce || secret.purpose !== intent.purpose || secret.nonce !== intent.resource_nonce || secret.native_pid !== process.pid || secret.process_birth !== native.native_process_birth || secret.native_resource_id !== native.native_resource_id) throw Error('per-launch PID/birth/purpose private secret binding differs');
      const {startProxy} = require(config.proxy.path);
      assertOpen();
      proxyPending = startProxy({ownedRoot:root,nonce:config.resource_nonce,secretFile:path.join(directory,'secret.private.json'),logFile:path.join(directory,'fault-events.jsonl'),
        binding:{clientHead:config.client_head,mainSha256:config.main_sha256,preloadSha256:config.preload_sha256,rendererManifestSha256:config.renderer_manifest_sha256,
          resourceNonce:config.resource_nonce,nativePid:process.pid,nativeResourceId:native.native_resource_id,nativeProcessBirth:native.native_process_birth,nativeBundleId:native.native_bundle_id,
          helperReviewVerdict:'pass',helperReviewSha256:config.helper_review_sha256,faultUseAuthorized:true}});
      harness = await proxyPending;
      assertOpen();
      privateWrite(path.join(directory,'listeners.private.json'),{...claim,process_birth:native.native_process_birth,proxy_port:harness.proxyPort,control_port:harness.controlPort});
      const registered = await waitPrivate(path.join(directory,'listeners-registration.private.json'),config.timeout_seconds,cancellation.signal);
      assertOpen();
      validateListeners(registered,native,[harness.proxyPort,harness.controlPort]);
      if(closing)throw Error('native lifecycle owner shutdown during listener readiness');
      await control(harness.controlPort,secret.secret,config.resource_nonce,'/mode',{mode:'FAULT'});
      assertOpen();
      const rules = config.startup_arm_next?.[intent.purpose] || [];
      if (!Array.isArray(rules) || rules.length > 3) throw Error('bounded exact startup fault rules required');
      for (const rule of rules) {
        assertOpen();
        await control(harness.controlPort,secret.secret,config.resource_nonce,'/arm-next',rule);
        assertOpen();
      }
      const {installPortRegistrationWrapper} = require(config.port_wrapper.path);
      interception=installPortRegistrationWrapper(electron.ipcMain,harness);
      electron.app.once('before-quit',()=>{void shutdown();});
      if(closing)throw Error('native lifecycle owner shutdown before startup admission');
      startup.check();
      startup.restore();
      privateWrite(path.join(directory,'ready.private.json'),{...claim,native_resource_id:native.native_resource_id,process_birth:native.native_process_birth,proxy_port:harness.proxyPort,control_port:harness.controlPort,main_required:true,main_loaded_synchronously:true,startup_admitted:true,native_execution_verified:false});
      startup.release();
      return mainResult;
    } catch (error) {
      return fail(error);
    }
  };
  // Failure is durable and exits only this native process; no global cleanup/sweep.
  ready=run().catch(()=>undefined);
  return {ready,shutdown};
}
module.exports={start,privateRead,privateWrite,validateIntent,validateRegistration,validateListeners,validateLoadedBundles,PURPOSES};
