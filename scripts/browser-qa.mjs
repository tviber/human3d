import {chromium} from 'playwright';
import {register} from 'tsx/esm/api';
import {launchQaBrowser} from './lib/qa-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveOutputDir,assertTrackedWriteAllowed,atomicWriteFile,ensureOutputDir} from './lib/qa-output.mjs';
// Dev-server URL for a motion-core source module: the Vite root is apps/web,
// so workspace sources outside it are served through /@fs/ (the config's
// server.fs.allow covers the repo root).
const coreModule=p=>`/@fs/${path.resolve('packages/motion-core/src',p)}`;
const repoRoot=process.cwd();
const output=resolveOutputDir('browser-qa',process.argv.slice(2),repoRoot,process.env);
if(output.args.length)throw new Error(`unexpected browser QA arguments: ${output.args.join(' ')}`);
ensureOutputDir(output.dir,{root:repoRoot,updateEvidence:output.updateEvidence});
const outputFile=name=>assertTrackedWriteAllowed(path.join(output.dir,name),{root:repoRoot,updateEvidence:output.updateEvidence});
register();
const webBase=new URL(process.env.QA_WEB_URL??`http://127.0.0.1:${process.env.HUMAN3D_WEB_PORT??5173}/`);
const serviceBase=new URL(process.env.QA_SERVICE_URL??`http://127.0.0.1:${process.env.HUMAN3D_PORT??8788}/`);
const webUrl=route=>new URL(route,webBase).href;
const serviceUrl=route=>new URL(route,serviceBase).href;
// Web identity is checked before the browser starts (issue #11 WP-0C): the
// dev server must serve THIS checkout's files — a foreign worktree's Vite on
// the shared 5173 port is a failure, never a silent reuse. QA_WEB_URL is an
// explicit opt-in: an unverifiable identity is annotated, not silently trusted.
const {verifyWebIdentity}=await import('./lib/worktree-check.mjs');
const webIdentity=await verifyWebIdentity(repoRoot,webBase);
if(process.env.QA_WEB_URL!==undefined){
 if(!webIdentity.ok)console.warn(`QA_WEB_URL is an explicit opt-in: web checkout identity NOT verified (${webIdentity.detail})`);
}else if(!webIdentity.ok){
 throw new Error(`dev server at ${webBase.origin} does not serve this checkout (${webIdentity.detail}); start it from this worktree (npm run dev) or opt in explicitly with QA_WEB_URL`);
}
const browser=await launchQaBrowser(chromium,{...(process.env.QA_BROWSER_CHANNEL?{channel:process.env.QA_BROWSER_CHANNEL}:{})});
let svc;
let cleanupPromise;
// Idempotent: the mid-run shutdown and the finally cleanup share one path.
const closeService=async()=>{
 if(!svc)return;
 const server=svc;svc=undefined;
 const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
};
const cleanup=()=>cleanupPromise??=(async()=>{
 await closeService();
 await browser.close();
})();
try {
const page=await browser.newPage({viewport:{width:1536,height:1024},deviceScaleFactor:1});
const errors=[],warnings=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
await page.goto(webUrl('/'));await page.waitForFunction(()=>window.__LAB__?.ready,{timeout:60000});await page.locator('.loading-state').waitFor({state:'hidden'});
assert.match(await page.title(),/KINESIS/);const bundledMotionCount=await page.locator('.motion-row').count();assert(bundledMotionCount>=8,'expected the bundled motion library');assert.equal(await page.locator('vite-error-overlay').count(),0);
// Issue #30 PR-B: the 观察面板 collapses by default on desktop — expand it
// once; the debug/speed/seek checks below operate on its controls.
await page.getByRole('button',{name:'展开动作库面板'}).click();
await page.getByRole('button',{name:'展开观察面板'}).click();
await page.getByRole('switch',{name:'人体表面'}).waitFor({state:'visible',timeout:5000});
const names={idle:'自然站立',walk:'行走',reach:'抬手与转身',squat:'下蹲',ready:'持拍准备',forehand:'正手挥拍'};
// Issue #30 PR-B: secondary workshop panels are collapsed <details> folds;
// open them all (idempotent) after every workshop navigation or reload.
const openWsFolds=async()=>{
 if(await page.getByTestId('mode-edit').getAttribute('aria-pressed')!=='true')await page.getByTestId('mode-edit').click();
 for(const side of ['left','right'])if(await page.getByTestId(`sheet-${side}`).getAttribute('aria-expanded')!=='true')await page.getByTestId(`sheet-${side}`).click();
 await page.getByTestId('adjustment-tab-common').click();
 await page.evaluate(()=>{document.querySelectorAll('[data-fold]').forEach(el=>{el.open=true;});});
};
async function choose(id,t=0,view='front'){
 // .first(): an opened bundled package reuses the envelope name, so the
 // motion list can hold two identically labelled rows — the bundled one
 // always precedes the appended package entries.
 await page.locator('.motion-row').filter({hasText:names[id]}).first().click();
 await page.evaluate(t=>{window.__LAB__.setPlaying(false);window.__LAB__.seek(t);},t);
 const views={front:'正面',side:'侧面',back:'背面',threeQuarter:'45°',hand:'手部特写'};
 if(view==='hand')await page.getByRole('button',{name:views[view],exact:true}).click();else await page.locator('.camera-toolbar').getByRole('button',{name:views[view],exact:true}).click();
 await page.waitForTimeout(250);assert.equal(await page.locator('.viewport-heading h2').textContent(),names[id]);
}
const poses=[['idle',0,'front','front'],['idle',0,'side','side'],['idle',0,'back','back'],['walk',.34,'threeQuarter','walk'],['reach',2.7,'front','reach'],['squat',2.7,'side','squat-side'],['squat',2.7,'front','squat'],['ready',0,'threeQuarter','ready'],['ready',0,'hand','grip'],['forehand',1.3,'threeQuarter','backswing'],['forehand',2.55,'front','contact'],['forehand',3.35,'threeQuarter','follow-through']];
const result={date:new Date().toISOString().slice(0,10),browser:await browser.version(),viewport:[1536,1024],poses:[],checks:{}};
const runHeavyQa=process.env.HUMAN3D_QA_HEAVY==='1';
result.skipped=[];
for(const [id,t,view,name]of poses){await choose(id,t,view);await page.screenshot({path:outputFile(`${name}.png`)});result.poses.push({id,t,view,file:`${name}.png`,metrics:await page.evaluate(()=>window.__LAB__.diagnostics())});}
await choose('squat',2.7,'threeQuarter');
for(const label of ['骨骼与关节','关节坐标轴','IK 端点']){await page.getByRole('switch',{name:label,exact:true}).click();assert.equal(await page.getByRole('switch',{name:label,exact:true}).getAttribute('aria-checked'),'true');}
await page.waitForTimeout(250);await page.screenshot({path:outputFile('debug.png')});
await page.getByRole('switch',{name:'人体表面',exact:true}).click();await page.screenshot({path:outputFile('skeleton.png')});
assert.equal(await page.evaluate(()=>{let visible=false;window.__LAB__.model.traverse(o=>{if(o.isSkinnedMesh&&o.visible)visible=true;});return visible;}),false);
for(const label of ['人体表面','骨骼与关节','关节坐标轴','IK 端点'])await page.getByRole('switch',{name:label,exact:true}).click();
result.checks.debug=true;
await choose('idle',0,'front');await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForTimeout(300);assert((await page.evaluate(()=>window.__LAB__.time))>.1);
await page.getByRole('button',{name:'暂停',exact:true}).click();const before=await page.evaluate(()=>window.__LAB__.time);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.__LAB__.time),before);result.checks.pause=true;
await page.getByLabel('播放速度',{exact:true}).fill('1.75');assert.equal(await page.evaluate(()=>window.__LAB__.speed),1.75);result.checks.speed=true;
await page.getByLabel('动作进度',{exact:true}).fill('2.4');assert(Math.abs((await page.evaluate(()=>window.__LAB__.time))-2.4)<.001);result.checks.seek=true;
// The reset starts playing immediately; allow automation/render latency, while
// requiring a clear reset from the previous 2.4s position.
await page.getByRole('button',{name:'重播',exact:true}).click();assert((await page.evaluate(()=>window.__LAB__.time))<1);result.checks.replay=true;
await page.getByRole('switch',{name:'循环播放',exact:true}).click();await page.evaluate(()=>{const e=window.__LAB__;e.speed=1;e.seek(4.7);e.setPlaying(true);});await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.__LAB__.playing),false);assert((await page.evaluate(()=>window.__LAB__.time))>4.79);result.checks.singlePlayback=true;
await page.getByRole('switch',{name:'循环播放',exact:true}).click();await page.getByLabel('播放速度',{exact:true}).fill('1');
// Real pointer orbit and wheel zoom, while preserving animation time.
await choose('idle',0,'front');const canvas=page.locator('canvas'),bounds=await canvas.boundingBox();const oldCam=await page.evaluate(()=>window.__LAB__.camera.position.toArray());
await page.mouse.move(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height*.53,{steps:12});await page.mouse.up();await page.mouse.wheel(0,-170);await page.waitForTimeout(300);assert.notDeepEqual(await page.evaluate(()=>window.__LAB__.camera.position.toArray()),oldCam);result.checks.orbitZoom=true;
await page.getByRole('button',{name:'资料与许可'}).click();assert(await page.locator('dialog').isVisible());assert.match(await page.locator('dialog').innerText(),/CC0/);await page.getByRole('button',{name:'关闭',exact:true}).click();result.checks.sources=true;
// Sample the real per-source state (including interpolation) for numerical review.
result.samples=await page.evaluate(()=>{const e=window.__LAB__,out={};for(const id of ['idle','walk','reach','squat','ready','forehand']){e.setMotion(id,false);e.setPlaying(false);const d=e.source.duration,frames=[];for(let i=0;i<80;i++){e.seek(i/80*d);frames.push({time:i/80*d,...e.diagnostics()});}out[id]=frames;}return out;});
for(const [id,samples]of Object.entries(result.samples)){assert(samples.every(s=>s.knee<=135.1&&s.elbow<=145.1));if(id==='forehand')assert(samples.every(s=>s.gripError<1e-8));}
result.checks.motionSamples=true;
// Responsive surface, including controls that move below the main canvas.
await page.setViewportSize({width:390,height:844});
// Phone drawer layout (#23/#28): the library and inspector are bottom sheets —
// raise each before touching its controls (the pre-drawer scrolling page is gone).
await page.getByTestId('sheet-library').click();
await choose('ready',0,'front'); // picking a motion closes the sheet again
await page.screenshot({path:outputFile('mobile.png')});
await page.getByTestId('sheet-inspector').click();
await page.getByRole('switch',{name:'人体表面'}).waitFor({state:'visible',timeout:5000});
await page.screenshot({path:outputFile('mobile-settings.png')});
await page.locator('.lab-scrim').click({position:{x:20,y:20}}); // the raised sheet covers the footer triggers and the scrim center
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);result.checks.mobileOverflow=false;
await page.setViewportSize({width:1366,height:900});await choose('idle',0,'front');await page.screenshot({path:outputFile('laptop.png')});
await page.setViewportSize({width:1536,height:1024});await choose('forehand',0,'threeQuarter');
await page.getByRole('switch',{name:'球拍运动轨迹',exact:true}).click();await page.evaluate(()=>{window.__LAB__.loop=false;window.__LAB__.speed=1;});
// Live VP9 capture is CPU intensive; reserve it for an explicit heavy QA run.
let videoBytes=0;
if(runHeavyQa){
 const recorded=await page.evaluate(async()=>{const e=window.__LAB__,stream=e.renderer.domElement.captureStream(30);const type=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';const recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:4500000}),chunks=[];recorder.ondataavailable=ev=>chunks.push(ev.data);const done=new Promise(resolve=>recorder.onstop=async()=>{const data=await new Blob(chunks,{type:'video/webm'}).arrayBuffer();stream.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(data)));});recorder.start();e.replay();const poll=setInterval(()=>{if(!e.playing){clearInterval(poll);setTimeout(()=>recorder.stop(),200);}},50);setTimeout(()=>{if(recorder.state==='recording'){clearInterval(poll);recorder.stop();}},15000);return done;});
 atomicWriteFile(outputFile('forehand.webm'),Buffer.from(recorded));videoBytes=recorded.length;result.checks.liveVideo=true;
}else result.skipped.push('liveVideo');
// --- Pose-package E2E: the real service solves a real package, delivered
// through the real file input, decoded by the lab's PosePackageSource.
// Service ownership is EXCLUSIVE by default: the port must be free so the QA
// spawns this checkout's own service — a foreign worktree process on the same
// port is a failure, never a silent reuse (issue #11 WP-0C). Setting
// QA_SERVICE_URL explicitly opts into an external service, whose identity is
// then verified (human3d-motion v1 + SERVICE_VERSION equal to this checkout's
// protocol.ts). Port reachability alone is never sufficient evidence.
const expectedServiceVersion=()=>{
 const text=fs.readFileSync(path.join(repoRoot,'packages/motion-core/src/protocol.ts'),'utf8');
 return /SERVICE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];
};
const verifyServiceIdentity=async()=>{
 const caps=await (await fetch(serviceUrl('/v1/capabilities'))).json();
 if(caps?.service?.name!=='human3d-motion'||caps?.service?.protocol!=='v1')
  throw new Error(`${serviceBase.origin} is not a human3d motion v1 service`);
 const expected=expectedServiceVersion();
 if(expected&&caps.service.version!==expected)
  throw new Error(`service at ${serviceBase.origin} reports SERVICE_VERSION ${caps.service.version}, but this checkout has ${expected} — refusing to QA against another checkout's service`);
};
if(process.env.QA_SERVICE_URL!==undefined){
 await verifyServiceIdentity();
}else{
 if(!['127.0.0.1','localhost','::1'].includes(serviceBase.hostname))throw new Error(`motion service is unavailable at ${serviceBase.origin}`);
 const {assertPortAvailable}=await import('./lib/worktree-check.mjs');
 await assertPortAvailable(serviceBase.hostname,Number(serviceBase.port||8788));
 const {startMotionService}=await import('../apps/server/src/serve.ts');
 svc=await startMotionService(Number(serviceBase.port||8788));
 await verifyServiceIdentity();
 if(!svc.listening)throw new Error(`motion service stopped at ${serviceBase.origin}`);
}
const pkgResponse=await fetch(serviceUrl('/v1/motions'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:{id:'idle'}})});
assert.equal(pkgResponse.status,200,'POST /v1/motions should return a pose package');
const pkg=await pkgResponse.json();
assert.equal(pkg.kind,'pose-package');assert.equal(pkg.rig.bones,163);
await page.locator('input[type=file]').setInputFiles({name:'idle.pose.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pkg))});
await page.waitForTimeout(300);
// Each opened package adds one temporary entry to the bundled motion list.
assert.equal(await page.locator('.motion-row').count(),bundledMotionCount+1);
// Envelope derivation: a bundled idle package restores the envelope display
// name, not the bare action id.
assert.equal(await page.locator('.viewport-heading h2').textContent(),'自然站立');
const pkgDiag=await page.evaluate(()=>{const e=window.__LAB__;e.setPlaying(false);e.seek(1.2);return {diagnostics:e.diagnostics(),status:e.source.status,error:e.source.error};});
assert.equal(pkgDiag.status,'ready');assert.equal(pkgDiag.diagnostics.bones,163);assert(pkgDiag.diagnostics.root.every(Number.isFinite),'pose-package root must be finite');
await page.screenshot({path:outputFile('pose-package.png')});result.checks.posePackage=true;
// Envelope derivation for a prop action: a bundled forehand package must
// remount the racket (constant display — v2 carries no per-frame grip) and
// resurface the hand-view/trail affordances; document.loop:false → one-shot.
const fhResponse=await fetch(serviceUrl('/v1/motions'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:{id:'forehand'}})});
assert.equal(fhResponse.status,200,'POST /v1/motions {forehand} failed');
const fhPkg=await fhResponse.json();
await page.locator('input[type=file]').setInputFiles({name:'forehand.pose.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fhPkg))});
await page.waitForTimeout(300);
assert.equal(await page.locator('.motion-row').count(),bundledMotionCount+2);
assert.equal(await page.locator('.viewport-heading h2').textContent(),'正手挥拍');
const fhState=await page.evaluate(()=>{const e=window.__LAB__;e.setPlaying(false);e.seek(2.55);return {racket:e.racket?.visible===true,prop:e.source?.kind==='pose-package'&&e.source.wantsProp()};});
assert.equal(fhState.prop,true,'forehand package source does not want the prop');
assert.equal(fhState.racket,true,'forehand package did not remount the racket');
assert(await page.getByRole('button',{name:'手部特写',exact:true}).isVisible(),'hand-view affordance missing for a prop package');
assert(await page.getByRole('switch',{name:'球拍运动轨迹',exact:true}).isVisible(),'trail affordance missing for a prop package');
assert(await page.getByRole('switch',{name:'循环播放',exact:true}).isDisabled(),'a non-loop document should replay one-shot');
result.checks.posePackageForehand=true;
await choose('idle',0,'front'); // restore a bundled motion before the workshop section
// NOTE: svc stays up — the workshop export assertions below POST the same
// document to the real service for the byte-parity check.
// --- Workshop E2E: real pointer drag → save → reload keeps the edited pose.
await page.goto(webUrl('/workshop.html'));
await page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});
// Issue #30 PR-B: secondary panels (presets, keyframe list, combine, generator,
// doc properties/advanced exports, video, legend) are collapsed folds — the QA
// run exercises all of them, so open every fold up front.
await openWsFolds();
assert.equal(await page.locator('.ws-key').count(),5);
assert.equal(await page.locator('canvas').count(),1);
await page.locator('.ws-newname').fill('QA 测试动作');
await page.getByRole('button',{name:'新建',exact:true}).click();
assert.equal(await page.locator('.ws-key').count(),2);
const handScreen=await page.evaluate(()=>{
 const e=window.__WS__;e.setPlaying(false);e.seek(0);
 const p=e.rig.point('wrist_R').project(e.camera);
 const r=e.renderer.domElement.getBoundingClientRect();
 return {x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height};
});
const seedTarget=await page.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-library')).docs.find(d=>d.name==='QA 测试动作').keys[0].pose.handR.target);
await page.mouse.move(handScreen.x,handScreen.y);await page.mouse.down();
await page.mouse.move(handScreen.x+60,handScreen.y-90,{steps:8});await page.mouse.up();
// Drag saves are throttled and the lock write is async: wait for the real
// invariant — storage equals the live document — instead of racing the writer
// and reading a mid-drag snapshot.
await page.waitForFunction(name=>{
 const stored=JSON.parse(localStorage.getItem('kinesis-workshop-library')).docs.find(d=>d.name===name)?.keys[0].pose.handR.target;
 const live=window.__WS__.getDoc().keys[0].pose.handR.target;
 return !!stored&&JSON.stringify(stored)===JSON.stringify(live);
},'QA 测试动作',{timeout:15000});
const moved=await page.evaluate(()=>window.__WS__.getDoc().keys[0].pose.handR.target);
assert(Math.hypot(moved.x-seedTarget.x,moved.y-seedTarget.y,moved.z-seedTarget.z)>.005,'drag edit was not persisted to storage');
const wristBefore=await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(0);return e.rig.point('wrist_R').toArray();});
await page.reload();await page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});await openWsFolds();
const libNames=await page.locator('.ws-lib-row .ws-lib-name span').allTextContents();
assert(libNames.some(n=>n.includes('QA 测试动作')));
// Reloading must restore the dragged wrist pose, not just the motion name:
// verify the persisted document, the live in-memory doc AND the solved bone
// position all match the pre-reload edit.
const persisted=await page.evaluate(()=>JSON.parse(localStorage.getItem('kinesis-workshop-library')).docs.find(d=>d.name==='QA 测试动作').keys[0].pose.handR.target);
assert.deepEqual(persisted,moved,'stored handR.target changed across reload — drag edit was not persisted');
// The workshop auto-plays on load: pin the playhead to t=0 before reading the
// wrist position, or a slow machine reads a frame after the compare pose.
// Solve explicitly before reading: `ready` can resolve a frame before the
// first document solve lands on the GPU-lagged rig, and the stale rest pose
// would read as a changed wrist.
const live=await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(0);e.solveCurrent?.();return {target:e.getDoc().keys[0].pose.handR.target,wrist:e.rig.point('wrist_R').toArray()};});
assert.deepEqual(live.target,moved,'live doc handR.target differs from the persisted edit');
assert(live.wrist.every((v,i)=>Math.abs(v-wristBefore[i])<.01),'solved wrist position changed across reload');
result.checks.workshopDragPersist=true;
// --- Workshop pose-package export: the in-browser builder must download a
// package that matches what POST /v1/motions {workshop-doc} serves — field
// by field (strings/structure exact, solved floats to ~1e-12; see below) —
// so the real service stays alive through this block for the peer comparison.
// This runs BEFORE the foot/swing edits below on purpose: those edits leave
// the document in a state the semantic validator rejects (the pelvis
// correction releasing mid-swing overshoots the root-acceleration limit —
// verified: 45.7 m/s² > 40), and a 422 artifact rightly has no download.
// The QA document id is random — the artifact id is compared to the service
// response, never asserted against a constant.
const wsExportFps=Number(await page.getByLabel(/采样率/).inputValue());
const [download]=await Promise.all([
 page.waitForEvent('download'),
 page.getByRole('button',{name:'导出姿态包',exact:true}).click(),
]);
const exportedText=fs.readFileSync(await download.path(),'utf8');
const exported=JSON.parse(exportedText);
const wireConsts=await page.evaluate(async url=>{const m=await import(url);return {kind:m.POSE_PACKAGE_KIND,schemaVersion:m.POSE_PACKAGE_SCHEMA_VERSION};},coreModule('package-const.ts'));
assert.equal(exported.kind,wireConsts.kind);
assert.equal(exported.schemaVersion,wireConsts.schemaVersion);
assert.equal(exported.timeline.timestamps.at(-1),exported.timeline.duration,'last timestamp is not exactly duration');
// The download name is content-addressed: <docId>.<artifactId>.pose.json.
const wsDoc=await page.evaluate(()=>window.__WS__.getDoc());
assert.equal(download.suggestedFilename(),`${wsDoc.id}.${exported.id}.pose.json`,'download filename is not the content-addressed name');
// The lab decoder's own structural check must accept the exported package.
const shapeProblems=await page.evaluate(async({pkg,url})=>{
 const {checkPosePackageShape}=await import(url);
 return checkPosePackageShape(pkg,new Set(window.__WS__.rig.bones.keys()));
},{pkg:exported,url:coreModule('package-inspect.ts')});
assert.deepEqual(shapeProblems,[],`shape check rejected the exported package: ${shapeProblems[0]??''}`);
// Peer parity: the same document through the real service must produce the
// same body — id, fingerprint, tracks, events and quality included.
// Structure, array lengths and every string field (artifact id, hashes,
// codes, labels) compare EXACTLY. Finite numbers get a small relative
// tolerance: the two solves run on two V8 builds (the page's Chrome vs this
// Node's), and ECMAScript does not pin transcendental functions to identical
// last ulps — observed drift is ~1e-17 on quaternion components. The
// same-engine byte-identity half of this contract is pinned separately by
// apps/server/src/package-export.test.ts (buildPosePackageLocal vs handleRequest
// under one Node process, toEqual on the full body).
const peerResponse=await fetch(serviceUrl('/v1/motions'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:{id:'workshop-doc',parameters:{document:wsDoc}},sample:{fps:wsExportFps}})});
assert.equal(peerResponse.status,200,'service POST /v1/motions rejected the workshop document');
const peerPkg=await peerResponse.json();
const nearEqual=(a,b,path='$')=>{
 if(typeof a==='number'||typeof b==='number')return (typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b)))?null:`${path}: ${a} != ${b}`;
 if(typeof a!==typeof b)return `${path}: ${typeof a} != ${typeof b}`;
 if(Array.isArray(a)||Array.isArray(b)){if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return `${path}: array shape differs`;for(let i=0;i<a.length;i++){const r=nearEqual(a[i],b[i],`${path}[${i}]`);if(r)return r;}return null;}
 if(a&&b&&typeof a==='object'){const ka=Object.keys(a),kb=Object.keys(b);if(ka.length!==kb.length||ka.some(k=>!(k in b)))return `${path}: object keys differ`;for(const k of ka){const r=nearEqual(a[k],b[k],`${path}.${k}`);if(r)return r;}return null;}
 return Object.is(a,b)?null:`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
};
const drift=nearEqual(exported,peerPkg);
assert.equal(drift,null,`browser-built package differs from the service response: ${drift}`);
// Everything except computed floats is bit-exact: strip numbers and require
// a literal deep-equal on the remaining skeleton (ids, hashes, enums).
const nonNumeric=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='number'?0:x));
assert.deepEqual(nonNumeric(exported),nonNumeric(peerPkg),'package skeleton (ids/hashes/labels) differs from the service response');
// Round-trip closure: the downloaded .pose.json must decode through the lab's
// real file input — the same path the service-built package used above.
await page.goto(webUrl('/'));
await page.waitForFunction(()=>window.__LAB__?.ready,{timeout:60000});
await page.locator('.loading-state').waitFor({state:'hidden'});
await page.locator('input[type=file]').setInputFiles({name:download.suggestedFilename(),mimeType:'application/json',buffer:Buffer.from(exportedText)});
await page.waitForTimeout(300);
const roundtrip=await page.evaluate(()=>{const e=window.__LAB__;e.setPlaying(false);return {status:e.source.status,error:e.source.error,kind:e.source.kind};});
assert.equal(roundtrip.kind,'pose-package','exported package did not open as a pose-package source');
assert.equal(roundtrip.status,'ready',`exported package failed to load in the lab: ${roundtrip.error??''}`);
// The ad-hoc presentation channel surfaced: documentName becomes the entry name.
assert.equal(await page.locator('.viewport-heading h2').textContent(),'QA 测试动作','parameters.documentName did not reach the lab entry');
result.checks.workshopPackageExport=true;
await closeService(); // every service-dependent assertion is done
// Back to the workshop for the remaining pinned edits — the library
// persists the QA doc's active selection across the navigation.
await page.goto(webUrl('/workshop.html'));
await page.waitForFunction(()=>window.__WS__?.ready,{timeout:60000});await openWsFolds();
assert((await page.evaluate(()=>window.__WS__.getDoc().name)).includes('QA 测试动作'),'QA doc lost the active selection across navigation');
// --- Workshop GLB export: the derived binary download. Assert the container
// (magic, version, one animation, channel count matching the package's
// tracks) and a size floor — no in-browser decode, that path is covered by
// apps/server/src/glb-export.test.ts's mixer↔FK roundtrip on the real GLB.
const [glbDownload]=await Promise.all([
 page.waitForEvent('download'),
 page.getByRole('button',{name:'导出 GLB',exact:true}).click(),
]);
assert.equal(glbDownload.suggestedFilename(),`${wsDoc.id}.${exported.id}.glb`,'GLB filename is not <docId>.<artifactId>.glb');
const glbBuf=fs.readFileSync(await glbDownload.path());
assert.equal(glbBuf.readUInt32LE(0),0x46546C67,'GLB magic mismatch'); // 'glTF'
assert.equal(glbBuf.readUInt32LE(4),2,'GLB version is not 2');
assert(glbBuf.length>3_000_000,`GLB suspiciously small for a skinned model + clip: ${glbBuf.length}B`);
const glbJsonLen=glbBuf.readUInt32LE(12);
assert.equal(glbBuf.readUInt32LE(16),0x4E4F534A,'GLB first chunk is not JSON');
const glbJson=JSON.parse(glbBuf.subarray(20,20+glbJsonLen).toString('utf8'));
assert.equal(glbJson.animations.length,1,'exported GLB should carry exactly one animation');
const glbRotCh=glbJson.animations[0].channels.filter(c=>c.target.path==='rotation').length;
assert.equal(glbRotCh,exported.tracks.rotations.length,'GLB rotation channels differ from the package tracks');
result.checks.workshopGlbExport=true;
// Foot-height editing through the real UI: add a mid key, unplant the left
// foot on it — the key then starts a swing interval and its stored target is
// the mid-swing waypoint — then set the lift slider and confirm the solved
// foot actually leaves the ground inside that interval.
await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(.5);});
await page.waitForTimeout(150); // let the React frame state flush before addKey reads it
await page.getByRole('button',{name:'添加关键帧',exact:true}).click();
assert.equal(await page.locator('.ws-key').count(),3);
await page.locator('.ws-key').nth(1).click();
await page.getByTestId('adjustment-tab-left').click();
const liftSlider=page.locator('.ws-slider').filter({hasText:'左脚抬升高度'}).locator('input');
assert(await liftSlider.isDisabled(),'lift slider should be disabled while the foot is planted');
await page.locator('.ws-check').filter({hasText:'左脚支撑锁定'}).locator('input').uncheck();
assert(!(await liftSlider.isDisabled()),'lift slider did not enable after unplanting the foot');
await liftSlider.evaluate(el=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'0.35');el.dispatchEvent(new Event('input',{bubbles:true}));});
await page.waitForTimeout(200);
const lift=await page.evaluate(()=>{const e=window.__WS__;const ks=[...e.getDoc().keys].sort((a,b)=>a.time-b.time);const mid=ks[1];e.seek((mid.time+ks[2].time)/2);e.solveCurrent();return {target:mid.pose.footL.target.y,yaw:mid.pose.footL.yaw,pitch:mid.pose.footL.pitch,planted:mid.constraints.plantL,footY:e.rig.point('foot_L').y};});
assert.equal(lift.planted,false,'plantL did not toggle off via the UI');
// The slider sets sole lift; the stored value is ankle height — convert back
// with the same footLift() the UI uses instead of comparing raw target.y.
const soleLift=await page.evaluate(async({l,url})=>{const {footLift}=await import(url);return footLift(window.__WS__.footGeometry('L'),l.target,l.yaw,l.pitch);},{l:lift,url:coreModule('foot.ts')});
assert(Math.abs(soleLift-.35)<1e-3,`UI slider did not write sole lift .35 (got ${soleLift})`);
assert(lift.footY>.15,`solved foot did not leave the ground mid-swing (y=${lift.footY})`);
result.checks.workshopFootHeight=true;
// Waypoint 3D drag: during a release interval the actual-foot handle becomes
// passive and a separate swing-point handle carries the stored target —
// dragging it must move stored target, handle and the solved mid-swing foot
// together (the previous behaviour wrote the target but the handle never
// followed the mouse).
const wpBefore=await page.evaluate(()=>{
 const e=window.__WS__,ks=[...e.getDoc().keys].sort((a,b)=>a.time-b.time);
 e.seek((ks[1].time+ks[2].time)/2);e.solveCurrent();
 const sw=e.handles.find(x=>x.kind==='swing'&&x.side==='L'),foot=e.handles.find(x=>x.kind==='foot'&&x.side==='L');
 const p=sw.mesh.position.clone().project(e.camera),r=e.renderer.domElement.getBoundingClientRect();
 return {swVisible:sw.mesh.visible,footPassive:foot.passive===true,target:{...ks[1].pose.footL.target},footY:e.rig.point('foot_L').y,
   x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height};
});
assert(wpBefore.swVisible,'swing waypoint handle not visible during a release interval');
assert(wpBefore.footPassive,'foot handle should be passive during a release interval');
await page.mouse.move(wpBefore.x,wpBefore.y);await page.mouse.down();
await page.mouse.move(wpBefore.x+40,wpBefore.y-70,{steps:8});await page.mouse.up();
await page.waitForTimeout(150);
const wpAfter=await page.evaluate(()=>{
 const e=window.__WS__,ks=[...e.getDoc().keys].sort((a,b)=>a.time-b.time);
 e.seek((ks[1].time+ks[2].time)/2);e.solveCurrent();
 const sw=e.handles.find(x=>x.kind==='swing'&&x.side==='L');
 return {target:{...ks[1].pose.footL.target},handleY:sw.mesh.position.y,footY:e.rig.point('foot_L').y};
});
assert(wpAfter.target.y>wpBefore.target.y+.02,`waypoint drag did not raise stored target (${wpBefore.target.y}→${wpAfter.target.y})`);
assert(Math.abs(wpAfter.handleY-wpAfter.target.y)<1e-3,'swing handle did not track the stored target');
assert(wpAfter.footY>wpBefore.footY,'solved mid-swing foot did not move with the waypoint');
result.checks.workshopWaypointDrag=true;
// --- Onion skin: ghost skeleton LineSegments of neighbouring poses. Toggle
// the real checkbox → ghosts appear; the count control changes how many are
// visible; a real pointer drag freezes their buffers until release.
await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(.5);});
await page.getByTestId('display-menu').click();
await page.locator('.ws-check').filter({hasText:'洋葱皮'}).locator('input').check();
await page.waitForTimeout(200);
const readOnion=()=>page.evaluate(()=>{const out=[];window.__WS__.scene.traverse(o=>{if(o.userData?.onion)out.push({visible:o.visible,dir:o.userData.onion.dir,dist:o.userData.onion.dist,pos:Array.from(o.geometry.getAttribute('position').array)});});return out;});
let onionPool=await readOnion();
assert.equal(onionPool.length,6,'onion pool should hold 3 past + 3 future line skeletons');
assert(onionPool.every(g=>g.pos.every(Number.isFinite)),'ghost bone positions must be finite');
// Default keys mode, playhead parked on the mid key of the 3-key QA doc
// [0, .5, 1]: exactly one key brackets each side → one past + one future ghost.
const keyed=onionPool.filter(g=>g.visible);
assert.equal(keyed.length,2,'keys mode should ghost only the ±N keys bracketing the playhead');
assert.deepEqual(keyed.map(g=>g.dir).sort(),[-1,1],'keys mode should draw a past and a future ghost');
// Step mode at t=.5, Δt=.1: .3/.4/.6/.7 → 4 ghosts; count 3 → 6 ghosts.
await page.locator('.ws-field').filter({hasText:'模式'}).locator('select').selectOption('step');
await page.waitForTimeout(200);
assert.equal((await readOnion()).filter(g=>g.visible).length,4,'step mode with count 2 should draw t±{Δt,2Δt}');
await page.locator('.ws-field').filter({hasText:'数量'}).locator('input').fill('3');
await page.waitForTimeout(200);
const stepped=(await readOnion()).filter(g=>g.visible);
assert.equal(stepped.length,6,'step mode with count 3 should draw six ghosts');
const frozen=stepped.map(g=>g.pos);
await page.getByRole('button',{name:'关闭显示菜单'}).click();
// A real pointer drag on the wrist handle: while the drag is active the ghost
// buffers must not re-solve (the same !this.drag guard as rebuildAux); on
// release the pending docDirty rebuild refreshes them.
const dragSpot=await page.evaluate(()=>{const e=window.__WS__;const p=e.rig.point('wrist_R').project(e.camera);const r=e.renderer.domElement.getBoundingClientRect();return {x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height};});
await page.mouse.move(dragSpot.x,dragSpot.y);await page.mouse.down();
await page.mouse.move(dragSpot.x+50,dragSpot.y-40,{steps:6});
const during=(await readOnion()).filter(g=>g.visible);
assert.deepEqual(during.map(g=>g.pos),frozen,'onion ghosts re-solved while a drag was active');
await page.mouse.up();
await page.waitForTimeout(250);
const released=(await readOnion()).filter(g=>g.visible);
assert.equal(released.length,6,'onion ghosts should stay populated after the drag');
assert(released.some((g,i)=>frozen[i].some((v,j)=>v!==g.pos[j])),'onion ghosts did not re-solve after the drag ended');
await page.getByTestId('display-menu').click();
await page.locator('.ws-check').filter({hasText:'洋葱皮'}).locator('input').uncheck();
await page.getByRole('button',{name:'关闭显示菜单'}).click();
await page.waitForTimeout(200);
assert((await readOnion()).every(g=>!g.visible),'onion ghosts stayed visible after the toggle was switched off');
result.checks.workshopOnion=true;
// --- WP-D fixed-camera render export: real clicks → real downloads. PNG
// magic + IHDR pin the fixed output contract (640×720 per still/tile), the
// sheet's dimensions prove its 3-tile grid, and the engine must hand the
// transport back untouched — checked paused for the still and PLAYING for
// the sheet (capture pauses internally, then restores the running state).
await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(.5);});
const [stillDl]=await Promise.all([
 page.waitForEvent('download'),
 page.getByRole('button',{name:'渲染静帧',exact:true}).click(),
]);
assert.equal(stillDl.suggestedFilename(),`${wsDoc.id}.t0.50.png`,'still filename is not <docId>.t<sec>.png');
const stillBuf=fs.readFileSync(await stillDl.path());
assert.equal(stillBuf.readUInt32BE(0),0x89504E47,'still export is not a PNG'); // \x89PNG
assert.equal(stillBuf.readUInt32BE(16),640,'still width is not the fixed 640 px');
assert.equal(stillBuf.readUInt32BE(20),720,'still height is not the fixed 720 px');
assert(stillBuf.length>5000,`still suspiciously small for a rendered pose: ${stillBuf.length}B`);
const stillState=await page.evaluate(()=>({time:window.__WS__.time,playing:window.__WS__.playing}));
assert.deepEqual(stillState,{time:.5,playing:false},'still export did not restore the transport state');
// Sheet while playing: the QA doc has 3 keys → a 3×1 grid of fixed tiles plus
// the caption band. The whole sheet now runs inside ONE outer capture
// session — `capturing` is held from entry through the sheet's own toBlob —
// so each tile's endCapture restores the transport the session left parked
// (paused), and only the outer session's endCapture hands the RUNNING state
// back. A plain post-download `playing` read is still racy (the restored
// clock can play the 1 s QA doc out on software-GL before the download
// resolves), so endCapture is tapped: the assertion measures every restore
// instant itself, on the real path.
await page.evaluate(()=>{
 const e=window.__WS__;e.seek(0);e.setPlaying(true);
 const orig=e.endCapture.bind(e);
 window.__sheetRestores=[];
 e.endCapture=s=>{orig(s);window.__sheetRestores.push({t:e.time,p:e.playing});};
});
const [sheetDl]=await Promise.all([
 page.waitForEvent('download'),
 page.getByRole('button',{name:'关键帧拼图',exact:true}).click(),
]);
const sheetRestores=await page.evaluate(()=>window.__sheetRestores);
assert.equal(sheetDl.suggestedFilename(),`${wsDoc.id}.sheet.png`,'sheet filename is not <docId>.sheet.png');
const sheetBuf=fs.readFileSync(await sheetDl.path());
assert.equal(sheetBuf.readUInt32BE(0),0x89504E47,'sheet export is not a PNG');
assert.equal(sheetBuf.readUInt32BE(16),640*3,'3-key sheet should be three 640 px tiles wide');
assert.equal(sheetBuf.readUInt32BE(20),720+28,'3-key sheet should be one tile row plus the caption band');
assert(sheetBuf.length>stillBuf.length,'3-tile sheet should outweigh the single still');
assert.equal(sheetRestores.length,4,'sheet should end-capture once per tile plus the outer session release');
assert(sheetRestores.slice(0,3).every(r=>r.p===false),'per-tile restores must keep the transport paused — the sheet session still owns it');
const lastRestore=sheetRestores.at(-1);
assert.equal(lastRestore.p,true,'the outer session end must hand back the RUNNING transport');
// Every snapshot was taken inside the same outer session, so all four
// restores land on the one entry instant (however far playback advanced
// between setPlaying and the click landing).
assert(sheetRestores.every(r=>r.t===sheetRestores[0].t),'every restore must land on the single entry instant');
await page.evaluate(()=>{delete window.__WS__.endCapture;});
await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(.5);});
result.checks.workshopStillExport=true;
// --- WP-D workshopGripSide: switch the QA doc to left-hand grip through the
// real 握拍侧 select, confirm the racket remounts onto wrist_L, then drag the
// tip handle with a real pointer and require the edit to land on the LEFT
// hand target while handR stays untouched — the same pointerdown/move/up
// pipeline every other handle check uses, never a direct doc mutation.
await page.locator('.ws-key').nth(0).click();
await page.locator('.ws-field').filter({hasText:'握拍侧'}).locator('select').selectOption('L');
assert.equal(await page.evaluate(()=>window.__WS__.getDoc().gripSide),'L','UI 握拍侧 select did not write gripSide L');
await page.waitForTimeout(150); // let React flush the relabelled constraint row
const gripRow=page.locator('.ws-check').filter({hasText:'手握拍'});
assert.match(await gripRow.textContent(),/左手握拍/,'constraint row did not relabel to 左手握拍');
await gripRow.locator('input').check();          // key 0 grips
await page.locator('.ws-key').nth(1).click();
await gripRow.locator('input').check();          // mid key (.5 s) grips
await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(.5);e.solveCurrent();});
const mount=await page.evaluate(()=>{
 const e=window.__WS__,probe=e.handles.find(h=>h.kind==='tip').mesh.position.clone().set(0,0,0);
 return {parent:e.racket.parent?.name,visible:e.racket.visible,
  dL:e.racket.getWorldPosition(probe).distanceTo(e.rig.point('wrist_L')),
  dR:probe.distanceTo(e.rig.point('wrist_R'))};
});
assert.equal(mount.parent,'wrist_L','racket did not remount onto the left wrist');
assert.equal(mount.visible,true,'racket should be visible at full left-grip amount');
assert(mount.dL<.15,`racket origin sits ${mount.dL}m from wrist_L — not a left grip mount`);
assert(mount.dL<mount.dR,'racket origin is closer to the right wrist than the left');
// Tip-drag under left grip edits the LEFT hand target only.
const handBefore=await page.evaluate(()=>{const ks=[...window.__WS__.getDoc().keys].sort((a,b)=>a.time-b.time);return {l:{...ks[1].pose.handL.target},r:{...ks[1].pose.handR.target}};});
const tipScreen=await page.evaluate(()=>{
 const e=window.__WS__,h=e.handles.find(h=>h.kind==='tip');
 const p=h.mesh.position.clone().project(e.camera),r=e.renderer.domElement.getBoundingClientRect();
 return {x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height,visible:h.mesh.visible};
});
assert(tipScreen.visible,'tip handle must be visible under a left grip');
await page.mouse.move(tipScreen.x,tipScreen.y);await page.mouse.down();
await page.mouse.move(tipScreen.x+45,tipScreen.y-35,{steps:8});
await page.mouse.up();await page.waitForTimeout(150);
const handAfter=await page.evaluate(()=>{const ks=[...window.__WS__.getDoc().keys].sort((a,b)=>a.time-b.time);return {l:{...ks[1].pose.handL.target},r:{...ks[1].pose.handR.target}};});
assert(Math.hypot(handAfter.l.x-handBefore.l.x,handAfter.l.y-handBefore.l.y,handAfter.l.z-handBefore.l.z)>.005,'tip drag did not edit the left hand target');
assert.deepEqual(handAfter.r,handBefore.r,'left-grip tip drag must not touch handR.target');
result.checks.workshopGripSide=true;
// --- WP-D workshopMirror: real click on 「镜像动作」 → a NEW document enters
// the editing state (source doc stays in the library). The QA doc currently
// grips LEFT, so its mirror must arrive as right-hand grip; at t=.5 the new
// doc's solved wrists must be the x=0 reflection of the source's (same motion
// on the other side), and one undo step must land back on the source doc.
const preMirror=await page.evaluate(()=>{
 const e=window.__WS__;e.setPlaying(false);e.seek(.5);e.solveCurrent();
 return {id:e.getDoc().id,name:e.getDoc().name,gripSide:e.getDoc().gripSide??'R',
  wL:e.rig.point('wrist_L').toArray(),wR:e.rig.point('wrist_R').toArray(),
  count:JSON.parse(localStorage.getItem('kinesis-workshop-library')).docs.length};
});
assert.equal(preMirror.gripSide,'L','precondition: QA doc should be on left grip before mirroring');
await page.getByRole('button',{name:'镜像动作',exact:true}).click();
await page.waitForTimeout(200);
const postMirror=await page.evaluate(()=>{
 const e=window.__WS__;e.setPlaying(false);e.seek(.5);e.solveCurrent();
 const d=e.getDoc(),lib=JSON.parse(localStorage.getItem('kinesis-workshop-library'));
 return {id:d.id,name:d.name,gripSide:d.gripSide??'R',activeId:lib.activeId,
  wL:e.rig.point('wrist_L').toArray(),wR:e.rig.point('wrist_R').toArray(),
  racketParent:e.racket.parent?.name,racketVisible:e.racket.visible,
  count:lib.docs.length,mirroredEntry:lib.docs.some(x=>x.id.endsWith('.mirrored')&&x.name.includes('镜像'))};
});
assert.notEqual(postMirror.id,preMirror.id,'mirror must produce a new document id');
assert.equal(postMirror.id,`${preMirror.id}.mirrored`,'mirrored doc id must carry the .mirrored marker');
assert(postMirror.mirroredEntry&&postMirror.count===preMirror.count+1,'library must gain the mirrored entry and keep the source');
assert.equal(postMirror.activeId,postMirror.id,'mirrored doc should become the active edit target');
assert.equal(postMirror.gripSide,'R','mirror of a left-grip doc must grip right');
assert(postMirror.name.includes('镜像'),'mirrored doc name must carry the 镜像 marker');
assert.equal(postMirror.racketParent,'wrist_R','mirrored doc should mount the racket back on the right wrist');
// The hard geometric contract on the real solved rig: the mirrored doc's
// wrist_L is the x-reflection of the source's wrist_R and vice versa.
const near=(a,b,tol=1e-5)=>Math.abs(a-b)<tol;
assert(near(postMirror.wL[0],-preMirror.wR[0])&&near(postMirror.wL[1],preMirror.wR[1])&&near(postMirror.wL[2],preMirror.wR[2]),
 `mirrored wrist_L ${postMirror.wL} is not the x-mirror of source wrist_R ${preMirror.wR}`);
assert(near(postMirror.wR[0],-preMirror.wL[0])&&near(postMirror.wR[1],preMirror.wL[1])&&near(postMirror.wR[2],preMirror.wL[2]),
 `mirrored wrist_R ${postMirror.wR} is not the x-mirror of source wrist_L ${preMirror.wL}`);
// One undo step returns the SOURCE document (cross-document history step).
await page.getByRole('button',{name:'撤销',exact:true}).click();
await page.waitForTimeout(200);
const undone=await page.evaluate(()=>{
 const e=window.__WS__;e.setPlaying(false);e.seek(.5);e.solveCurrent();
 const d=e.getDoc();
 return {id:d.id,gripSide:d.gripSide??'R',wL:e.rig.point('wrist_L').toArray(),wR:e.rig.point('wrist_R').toArray()};
});
assert.equal(undone.id,preMirror.id,'one undo step did not return to the source document');
assert.equal(undone.gripSide,'L','undo should restore the source doc with its left grip');
assert(near(undone.wL[0],preMirror.wL[0],1e-4)&&near(undone.wR[0],preMirror.wR[0],1e-4),'restored doc solves differently than the source');
result.checks.workshopMirror=true;
// --- Issue #10 WP-E: real module-Worker generation on a five-key forehand.
// Import the same action used by the core acceptance evidence through the
// Workshop's actual JSON import path, then assert cancellation is a byte-stable
// no-op before running a full A/B → keep → export → undo/redo round trip.
const forehandDoc=JSON.parse(fs.readFileSync('spec/examples/forehand-study.request.json','utf8')).action.parameters.document;
// nth(0): the library card hosts two JSON inputs — 导入动作 and 从备份恢复.
await page.locator('input[type=file][accept=".json,application/json"]').first().setInputFiles({
 name:'forehand-study.workshop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(forehandDoc)),
});
await page.waitForFunction(()=>window.__WS__?.getDoc().name==='正手击球 · 研究',{timeout:10000});
// Endpoint defaults must follow the current first/last key ids, even after a
// user's lock toggle materializes per-document overrides and the last key is
// replaced by a newly authored endpoint.
const lockProbe=await page.evaluate(()=>window.__WS_GENERATOR__.source());
const lockProbeInterior=lockProbe.keys.find((k,i)=>i>0&&i<lockProbe.keys.length-1&&!k.constraints.contact);
assert(lockProbeInterior,'lock regression fixture has no adjustable interior key');
await openWsFolds();
await page.getByTestId(`generator-lock-${lockProbeInterior.id}`).check();
await page.locator('.ws-track-labels button').last().click();
await page.getByRole('button',{name:'删除此关键帧'}).click();
await page.evaluate(()=>window.__WS__.seek(1.9));
await page.getByRole('button',{name:'添加关键帧',exact:true}).click();
await page.waitForFunction(()=>window.__WS_GENERATOR__.source().keys.length===5,{timeout:5000});
const newEndpoint=await page.evaluate(()=>window.__WS_GENERATOR__.source().keys.at(-1));
assert.equal(newEndpoint.time,1.9,'lock regression fixture did not create a replacement endpoint');
assert(await page.getByTestId(`generator-lock-${newEndpoint.id}`).isChecked(),'new last key lost its default lock after lock overrides were created');
while(await page.evaluate(({id,time})=>window.__WS_GENERATOR__.source().keys.some(k=>k.id!==id&&k.time>time),{id:lockProbeInterior.id,time:lockProbeInterior.time})){
 await page.locator('.ws-track-labels button').last().click();
 await page.getByRole('button',{name:'删除此关键帧'}).click();
}
const nowEndpointLock=page.getByTestId(`generator-lock-${lockProbeInterior.id}`);
assert(await nowEndpointLock.isChecked(),'previously locked interior key did not follow its lock after becoming an endpoint');
await nowEndpointLock.uncheck();
assert(!(await nowEndpointLock.isChecked()),'a formerly interior key could not be unlocked after becoming an endpoint');
// Restore the fixture through the same single-action UI import, rather than
// changing only the localStorage mirror behind its canonical snapshot.
await page.locator('input[type=file][accept=".json,application/json"]').first().setInputFiles({
 name:'forehand-study.workshop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(forehandDoc)),
});
await page.waitForFunction(()=>document.querySelector('[data-testid=save-state]')?.getAttribute('data-state')==='saved');
await page.reload();
await page.waitForFunction(()=>window.__WS__?.rig&&window.__WS_GENERATOR__?.source().name==='正手击球 · 研究',{timeout:30000});
await openWsFolds();
result.checks.workshopGenerationEndpointLock=true;
await page.evaluate(()=>{const e=window.__WS__;e.setPlaying(false);e.seek(.9);});
await page.locator('.ws-cameras').getByRole('button',{name:'45°',exact:true}).click();
await page.locator('[data-testid="generator-start"]').scrollIntoViewIfNeeded();
if(runHeavyQa){
const cancelBefore=await page.evaluate(()=>({
 storage:localStorage.getItem('kinesis-workshop-library'),
 active:window.__WS_GENERATOR__.activeId(),
 source:window.__WS_GENERATOR__.source(),
 history:window.__WS_GENERATOR__.history(),
 docs:JSON.parse(localStorage.getItem('kinesis-workshop-library')).docs.length,
}));
await page.locator('[data-testid="generator-start"]').click();
// Fast runs can finish the whole search between polls — the progress bar is
// unmounted on completion, so accept either live progress or a ready candidate.
await page.waitForFunction(()=>{
 const p=document.querySelector('progress[data-testid="generator-progress"]');
 const err=document.querySelector('.ws-generation-error');
 if(err)throw new Error(err.textContent);
 return (p&&Number(p.value)>0)||window.__WS_GENERATOR__.preview()!==null;
},null,{timeout:60000}).catch(async e=>{
 const dump=await page.evaluate(()=>({
  foldOpen:document.querySelector('[data-fold="generator"]')?.open,
  btn:[...document.querySelectorAll('[data-testid="generator-start"]')].map(b=>({disabled:b.disabled,visible:!!(b.offsetWidth||b.offsetHeight),rect:b.getBoundingClientRect().toJSON()})),
  busy:!!document.querySelector('progress[data-testid="generator-progress"]'),
  locked:window.__WS_GENERATOR__?.locked(),
  preview:!!window.__WS_GENERATOR__?.preview(),
  err:document.querySelector('.ws-generation-error')?.textContent??null,
  hint:document.querySelector('.ws-feedback')?.textContent?.slice(0,120)??null,
  worker:typeof Worker,
 }));
 throw new Error('generator wait: '+JSON.stringify(dump));
});
// The viewport and camera controls remain usable while search runs in a
// separate Worker. Change view, then cancel before the candidate is emitted.
await page.locator('.ws-cameras').getByRole('button',{name:'侧面',exact:true}).click();
assert.equal(await page.locator('.ws-cameras button[aria-pressed="true"]').textContent(),'侧面');
await page.locator('[data-testid="generator-cancel"]').click();
await page.waitForFunction(()=>!window.__WS_GENERATOR__.locked()&&window.__WS_GENERATOR__.preview()===null,{timeout:5000});
const cancelAfter=await page.evaluate(()=>({
 storage:localStorage.getItem('kinesis-workshop-library'),active:window.__WS_GENERATOR__.activeId(),
 source:window.__WS_GENERATOR__.source(),history:window.__WS_GENERATOR__.history(),
 docs:JSON.parse(localStorage.getItem('kinesis-workshop-library')).docs.length,
}));
assert.equal(cancelAfter.storage,cancelBefore.storage,'cancel changed persisted library bytes');
assert.equal(cancelAfter.active,cancelBefore.active,'cancel changed the active document');
assert.deepEqual(cancelAfter.source,cancelBefore.source,'cancel changed source document contents');
assert.deepEqual(cancelAfter.history,cancelBefore.history,'cancel changed source undo/redo history');
assert.equal(cancelAfter.docs,cancelBefore.docs,'cancel inserted a document into the library');
result.checks.workshopGenerationCancel=true;

// Full deterministic candidate path: preserve the source bytes, compare both
// docs at one fixed time/view, and verify the selected locked poses stay exact.
await page.locator('[data-testid="generator-start"]').click();
await page.locator('[data-testid="preview-candidate"]').waitFor({state:'visible',timeout:120000});
const generationPair=await page.evaluate(()=>({
 source:window.__WS_GENERATOR__.source(),candidate:window.__WS_GENERATOR__.preview(),
 storage:localStorage.getItem('kinesis-workshop-library'),active:window.__WS_GENERATOR__.activeId(),
 history:window.__WS_GENERATOR__.history(),
}));
assert(generationPair.candidate,'candidate preview is missing');
assert.notDeepEqual(generationPair.candidate,generationPair.source,'generator only re-labelled the source document');
assert.equal(generationPair.storage,cancelAfter.storage,'generation persisted before Keep');
assert.equal(generationPair.active,cancelBefore.active,'generation changed the active document before Keep');
for(const id of ['k-ready','k-contact']){
 const a=generationPair.source.keys.find(k=>k.id===id),b=generationPair.candidate.keys.find(k=>k.id===id);
 assert(a&&b,`missing protected key ${id}`);assert.equal(b.time,a.time,`${id} time moved`);assert.deepEqual(b.pose,a.pose,`${id} pose moved`);
}
assert(generationPair.candidate.keys.every(k=>{
 const source=generationPair.source.keys.find(x=>x.id===k.id);return source&&JSON.stringify(k.constraints)===JSON.stringify(source.constraints);
}),'candidate changed a source constraint');
assert.match(await page.locator('[data-testid="generator-status"]').innerText(),/候选已就绪/);
assert.equal(await page.getByRole('table',{name:'源动作与候选指标比较'}).count(),1,'candidate metric comparison table missing');

await page.locator('.ws-cameras').getByRole('button',{name:'45°',exact:true}).click();
await page.evaluate(()=>{window.__WS__.setPlaying(false);window.__WS__.seek(.9);});
await page.waitForTimeout(180);
const abState=await page.evaluate(()=>({time:window.__WS__.time,view:window.__WS__.view,camera:window.__WS__.camera.position.toArray()}));
await page.locator('[data-testid="preview-source"]').click();await page.waitForTimeout(180);
assert.deepEqual(await page.evaluate(()=>window.__WS__.camera.position.toArray()),abState.camera,'A preview changed the camera');
await page.locator('.ws-canvas canvas').screenshot({path:outputFile('generate-forehand-source.png')});
await page.locator('[data-testid="preview-candidate"]').click();await page.waitForTimeout(180);
assert.equal(await page.evaluate(()=>window.__WS__.time),abState.time,'B preview changed the playhead time');
assert.equal(await page.evaluate(()=>window.__WS__.view),abState.view,'B preview changed the camera preset');
assert.deepEqual(await page.evaluate(()=>window.__WS__.camera.position.toArray()),abState.camera,'B preview changed the camera');
await page.locator('.ws-canvas canvas').screenshot({path:outputFile('generate-forehand-candidate.png')});
result.checks.workshopGenerationAB=true;

const keptIdBefore=await page.evaluate(()=>{
 const lib=JSON.parse(localStorage.getItem('kinesis-workshop-library'));
 return {count:lib.docs.length,sourceId:window.__WS_GENERATOR__.activeId(),source:window.__WS_GENERATOR__.source()};
});
const [keptDownload]=await Promise.all([
 page.waitForEvent('download'),page.locator('[data-testid="generator-keep-export"]').click(),
]);
const keptId=await page.evaluate(()=>window.__WS_GENERATOR__.activeId());
assert.notEqual(keptId,keptIdBefore.sourceId,'Keep must create a distinct document id');
assert.equal(keptDownload.suggestedFilename(),`${keptId}.workshop.json`,'candidate export did not use the existing Workshop JSON filename');
const keptText=fs.readFileSync(await keptDownload.path(),'utf8'),keptExport=JSON.parse(keptText);
assert.equal(keptExport.id,keptId,'downloaded doc id differs from the retained candidate');
assert.equal(new Set(keptExport.keys.map(k=>k.id)).size,keptExport.keys.length,'retained candidate key ids are not unique');
assert(keptExport.keys.every(k=>k.id.startsWith(`${keptId}-k`)),'retained keys were not assigned fresh ids');
const keptState=await page.evaluate(()=>{
 const lib=JSON.parse(localStorage.getItem('kinesis-workshop-library'));
 return {lib,active:window.__WS_GENERATOR__.activeId(),preview:window.__WS_GENERATOR__.preview(),history:window.__WS_GENERATOR__.history()};
});
assert.equal(keptState.active,keptId,'retained candidate is not the active document');
assert.equal(keptState.preview,null,'retained candidate kept a volatile preview override');
assert.equal(keptState.lib.docs.length,keptIdBefore.count+1,'Keep did not add exactly one document');
assert.deepEqual(keptState.lib.docs.find(d=>d.id===keptIdBefore.sourceId),keptIdBefore.source,'Keep modified the source document');
assert(keptState.history.canUndo,'retained candidate did not seed its undo path');
await page.getByRole('button',{name:'撤销',exact:true}).click();await page.waitForTimeout(160);
assert.equal(await page.evaluate(()=>window.__WS_GENERATOR__.activeId()),keptIdBefore.sourceId,'undo after Keep did not return to the source');
await page.getByRole('button',{name:'重做',exact:true}).click();await page.waitForTimeout(160);
assert.equal(await page.evaluate(()=>window.__WS_GENERATOR__.activeId()),keptId,'redo after Keep did not return to the candidate');
result.checks.workshopGenerationKeepExportUndo=true;
}else result.skipped.push('workshopGenerationCancel','workshopGenerationAB','workshopGenerationKeepExportUndo');

result.errors=errors;result.warnings=warnings;assert.deepEqual(errors,[]);
atomicWriteFile(outputFile('browser-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks:result.checks,skipped:result.skipped,errors,warnings,poses:result.poses.length,videoBytes},null,2));

} finally {await cleanup();}
