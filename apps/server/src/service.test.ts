import {describe,it,expect,beforeAll} from 'vitest';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {createService,handleRequest,actionCatalog,actionDefinitionHash,artifactId,LIMITS_SVC,type ServiceContext} from './service';
import {validatePosePackage} from '@human3d/motion-core';
import {sha256} from './rig-manifest';
import {SERVICE_VERSION,canonical,normalizedRequest} from '@human3d/motion-core';
import {motionFileById} from '@human3d/motion-core';
import {motionDefinitionPayload} from '@human3d/motion-core';
import {blankDocument,retimeKeys} from '@human3d/motion-core';
import type {PosePackage} from '@human3d/motion-core';
let ctx:ServiceContext;
beforeAll(async()=>{ctx=await createService('public');},30000);
const post=(body:unknown,headers:Record<string,string>={})=>handleRequest(ctx,'POST','/v1/motions',body,headers);
describe('capability catalog',()=>{
 it('lists only honestly servable actions and the single rig',()=>{
  const r=handleRequest(ctx,'GET','/v1/capabilities');
  expect(r.status).toBe(200);
  const c=r.body as {service:{version:string};actions:{id:string;kind:string}[];rigs:{id:string}[];limits:{maxFps:number}};
  expect(c.service.version).toBe(SERVICE_VERSION);
  expect(c.actions.map(a=>a.id).sort()).toEqual([
   'basic-arms-up','basic-forward-fold','basic-full-squat','basic-half-squat','basic-lunge','basic-push-turn',
   'basic-weight-shift','basic-wide-squat','forehand','idle',
   'reach','ready','squat','workshop-doc',
  ]);
  expect(c.rigs[0].id).toBe('makehuman-body');
  expect(c.limits.maxFps).toBe(60);
 });
 it('never advertises muscle-dynamics or mocap actions it cannot serve at request time',()=>{
  const ids=actionCatalog().map(a=>a.id);
  for(const id of ['walk','punch','throw','baseball-throw','shotput'])expect(ids).not.toContain(id);
 });
 it('returns per-action descriptors and 404 for unknown ids',()=>{
  const ok=handleRequest(ctx,'GET','/v1/actions/forehand');
  expect(ok.status).toBe(200);
  expect((ok.body as {notes:string[]}).notes[0]).toContain('research-reference');
  expect(handleRequest(ctx,'GET','/v1/actions/fly').status).toBe(404);
 });
});
describe('rig manifest',()=>{
 it('describes 163 bones with rest local TRS and VRM semantics',()=>{
  const r=handleRequest(ctx,'GET','/v1/rigs/makehuman-body');
  expect(r.status).toBe(200);
  const m=r.body as {bones:{name:string;parent:string|null;restLocal:{translation:number[];rotation:number[];scale:number[]};semantic:string}[];manifestSHA256:string;semantics:{mapped:number}};
  expect(m.bones.length).toBe(163);
  expect(m.manifestSHA256).toMatch(/^[0-9a-f]{64}$/);
  expect(m.semantics.mapped).toBeGreaterThanOrEqual(40);
  const wrist=m.bones.find(b=>b.name==='wrist_R')!;
  expect(wrist.semantic).toBe('rightHand');
  expect(wrist.restLocal.rotation).toEqual([0,0,0,1]);
  const upper=m.bones.find(b=>b.name==='upperleg01_L')!;
  const child=m.bones.find(b=>b.name==='lowerleg01_L')!;
  expect(child.restLocal.translation[1]).toBeCloseTo(-0.42,0);
 });
 it('rejects rigs it cannot serve',()=>{
  const r=post({action:{id:'idle'},rig:'smpl-24'});
  expect(r.status).toBe(409);
  expect((r.body as {error:{missing:string[]}}).error.missing).toContain('retarget adapter');
 });
});
describe('POST /v1/motions — bundled actions',()=>{
 it('solves squat into a package that passes independent validation',()=>{
  const r=post({action:{id:'squat',parameters:{}}});
  expect(r.status).toBe(200);
  const pkg=r.body as PosePackage;
  expect(pkg.kind).toBe('pose-package');
  expect(pkg.id).toMatch(/^mot_[0-9a-f]{16}$/);
  expect(pkg.timeline.count).toBe(Math.round(5.6*40)+1);
  expect(pkg.tracks.rotations.length).toBeGreaterThan(20);
  expect(pkg.tracks.rotations.length).toBeLessThan(163);
  expect(pkg.tracks.rotations.every(t=>t.values.length===pkg.timeline.count*4)).toBe(true);
  expect(pkg.events.map(e=>e.label)).toContain('最低点');
  expect(validatePosePackage(pkg,ctx.manifest)).toEqual([]);
 });
 it('reports per-frame quality checks and carries the envelope notes as warnings',()=>{
  const pkg=post({action:{id:'forehand'}}).body as PosePackage;
  // Envelope notes land in warnings verbatim; the forehand is a research
  // reference approximation, not a documented defect any more.
  expect(pkg.quality.warnings[0]).toContain('research-reference');
  expect(pkg.quality.warnings.some(w=>w.includes('穿插'))).toBe(false);
  const ids=pkg.quality.checks.map(c=>c.code);
  for(const s of ['L','R'])expect(ids).toEqual(expect.arrayContaining([`knee-flexion-${s}`,`elbow-flexion-${s}`,`shoulder-elevation-${s}`,`foot-depth-${s}`,`ankle-dorsiflexion-${s}`]));
  // Codes are stable machine identifiers: lower-case, hyphenated, side-suffixed.
  for(const c of pkg.quality.checks)expect(c.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*(-[LR])?$/);
  expect(validatePosePackage(pkg,ctx.manifest)).toEqual([]);
 });
 it('honors requested sample fps',()=>{
  const pkg=post({action:{id:'idle'},sample:{fps:10}}).body as PosePackage;
  expect(pkg.timeline.fps).toBe(10);
  expect(pkg.timeline.count).toBe(Math.round(4.8*10)+1);
 });
 it('always ends the timeline at exactly duration, even for non-integer duration×fps',()=>{
  const a=post({action:{id:'forehand'},sample:{fps:1}}).body as PosePackage;
  expect(a.timeline.duration).toBe(5.2);
  expect(a.timeline.timestamps.at(-1)).toBe(5.2);
  expect(a.timeline.timestamps.length).toBe(a.timeline.count);
  const b=post({action:{id:'idle'},sample:{fps:7}}).body as PosePackage;
  expect(b.timeline.timestamps.at(-1)).toBe(4.8);
  expect(b.timeline.timestamps.length).toBe(b.timeline.count);
  const doc=blankDocument(ctx.rig.rest,'短','short');retimeKeys(doc,.3);
  const c=post({action:{id:'workshop-doc',parameters:{document:doc}}}).body as PosePackage;
  expect(c.timeline.duration).toBe(.3);
  expect(c.timeline.timestamps.at(-1)).toBe(.3);
  for(const p of [a,b,c])expect(validatePosePackage(p,ctx.manifest)).toEqual([]);
 });
});
describe('POST /v1/motions — workshop-doc action',()=>{
 it('solves a validated WorkshopDoc with constraint events and keyframe checks',()=>{
  const doc=blankDocument(ctx.rig.rest,'深蹲变体','test-doc');
  doc.keys[1].constraints.contact=true;doc.keys[1].label='触地';
  const r=post({action:{id:'workshop-doc',parameters:{document:doc}}});
  expect(r.status).toBe(200);
  const pkg=r.body as PosePackage;
  expect(pkg.events.some(e=>e.type==='contact')).toBe(true);
  expect(pkg.events.some(e=>e.type==='support-start')).toBe(true);
  expect(pkg.quality.checks.some(c=>c.code.startsWith('com-support'))).toBe(true);
  expect(validatePosePackage(pkg,ctx.manifest)).toEqual([]);
 });
 it('solves the selected linear curve and versions its artifact',()=>{
  const doc=JSON.parse(JSON.stringify(motionFileById('forehand')!.document!));
  const smooth=post({action:{id:'workshop-doc',parameters:{document:doc}},sample:{fps:10}});
  const linearDoc=JSON.parse(JSON.stringify(doc));linearDoc.keys[0].interpolation='linear';
  const linear=post({action:{id:'workshop-doc',parameters:{document:linearDoc}},sample:{fps:10}});
  expect(smooth.status).toBe(200);expect(linear.status).toBe(200);
  const a=smooth.body as PosePackage,b=linear.body as PosePackage;
  expect(a.id).not.toBe(b.id);
  expect(a.provenance.solverRevision).toBe(SERVICE_VERSION);
  expect(b.provenance.solverRevision).toBe(SERVICE_VERSION);
  expect(a.tracks).not.toEqual(b.tracks);
 });
 it('emits support events only at interval boundaries, one pair per contact',()=>{
  const doc=blankDocument(ctx.rig.rest,'换脚','support-events');
  // Both feet planted at key0; left lifts at key1 (a contact ends), then a
  // new left contact starts at key2 — exactly one start/end pair each side.
  doc.keys[1].constraints.plantL=false;
  doc.keys.push({...doc.keys[1],id:'replant',time:2,constraints:{...doc.keys[1].constraints,plantL:true}});
  doc.duration=2;
  const pkg=post({action:{id:'workshop-doc',parameters:{document:doc}},sample:{fps:20}}).body as PosePackage;
  const starts=pkg.events.filter(e=>e.type==='support-start'),ends=pkg.events.filter(e=>e.type==='support-end');
  expect(starts.length).toBe(3); // L@0, R@0, L@2 — not one per planted key
  expect(ends.length).toBe(1);   // L@1
  expect(starts.filter(e=>e.time===0).length).toBe(2);
  expect(ends[0].time).toBe(1);
  expect(starts.filter(e=>e.time===2).length).toBe(1);
  expect(validatePosePackage(pkg,ctx.manifest)).toEqual([]);
 });
 it('rejects malformed and oversized documents',()=>{
  expect(post({action:{id:'workshop-doc',parameters:{}}}).status).toBe(400);
  expect(post({action:{id:'workshop-doc',parameters:{document:{bogus:true}}}}).status).toBe(400);
  const doc=blankDocument(ctx.rig.rest,'超长','long-doc');doc.duration=99;
  const r=post({action:{id:'workshop-doc',parameters:{document:doc}}});
  expect(r.status).toBe(400);
  expect((r.body as {error:{code:string}}).error.code).toBe('validation_failed');
 });
 it('rejects a non-R/L gripSide at the document gate',()=>{
  const raw=JSON.parse(JSON.stringify(blankDocument(ctx.rig.rest,'坏侧别','bad-side'))) as {gripSide?:string};
  raw.gripSide='B';
  const r=post({action:{id:'workshop-doc',parameters:{document:raw}}});
  expect(r.status).toBe(400);
  expect((r.body as {error:{code:string}}).error.code).toBe('validation_failed');
 });
 it('serves a left-grip document as a distinct artifact carrying the side hint',()=>{
  const doc=blankDocument(ctx.rig.rest,'左持拍','left-grip');
  doc.keys.forEach(k=>{k.constraints.grip=true;});
  const r0=post({action:{id:'workshop-doc',parameters:{document:doc}}});
  const left={...JSON.parse(JSON.stringify(doc)),gripSide:'L'};
  const r1=post({action:{id:'workshop-doc',parameters:{document:left}}});
  expect(r0.status).toBe(200);expect(r1.status).toBe(200);
  const a=r0.body as PosePackage,b=r1.body as PosePackage;
  for(const p of [a,b])expect(validatePosePackage(p,ctx.manifest)).toEqual([]);
  // The side selects which wrist and fingers the grip stage solves — a
  // trajectory-level difference, so BOTH content hashes move; same document
  // differing only in gripSide must never share an artifact id.
  expect(b.id).not.toBe(a.id);
  expect(b.action.definitionSHA256).not.toBe(a.action.definitionSHA256);
  const pres=(p:PosePackage)=>p.action.parameters.presentation as {prop:string;loop:boolean;gripSide?:string};
  expect(pres(a).gripSide).toBeUndefined();
  expect(pres(b).gripSide).toBe('L');
  // Solve-level proof: the left package wraps the LEFT fingers — its finger
  // track is the mirror-conjugate (x,−y,−z,w) of the right package's right-
  // finger track, not a copy of it.
  const tr=(p:PosePackage,bone:string)=>p.tracks.rotations.find(t=>t.bone===bone)!.values;
  const lv=tr(b,'finger2-1_L'),rv=tr(a,'finger2-1_R');
  expect(lv.length).toBe(rv.length);
  for(let i=0;i<lv.length;i+=4){
   expect(lv[i]).toBeCloseTo(rv[i],9);expect(lv[i+1]).toBeCloseTo(-rv[i+1],9);
   expect(lv[i+2]).toBeCloseTo(-rv[i+2],9);expect(lv[i+3]).toBeCloseTo(rv[i+3],9);
  }
 });
 it('keeps an explicitly spelled R identical to the omitted default',()=>{
  const doc=blankDocument(ctx.rig.rest,'同义','same-solve');
  const a=post({action:{id:'workshop-doc',parameters:{document:doc}}}).body as PosePackage;
  const spelled={...JSON.parse(JSON.stringify(doc)),gripSide:'R'};
  const b=post({action:{id:'workshop-doc',parameters:{document:spelled}}}).body as PosePackage;
  expect(b.id).toBe(a.id);
  expect(b.provenance.requestFingerprint).toBe(a.provenance.requestFingerprint);
 });
});
describe('request semantics',()=>{
 it('rejects unknown actions, bad fps, unsupported outputs and non-object bodies',()=>{
  expect(post({action:{id:'teleport'}}).status).toBe(404);
  expect(post({action:{id:'idle'},sample:{fps:500}}).status).toBe(400);
  expect(post({action:{id:'idle'},outputs:[{kind:'motion',format:'fbx'}]}).status).toBe(400);
  expect(post('hello').status).toBe(400);
 });
 it('returns 400 (not 500) for structurally malformed request fields',()=>{
  expect(post({action:{id:'idle'},outputs:'pose-json'}).status).toBe(400);
  expect(post({action:{id:'idle'},outputs:[null,'x',5]}).status).toBe(400);
  expect(post({action:{id:'idle'},outputs:[{kind:'render',format:'pose-json'}]}).status).toBe(400);
  expect(post({action:{id:'idle'},sample:30}).status).toBe(400);
  expect(post({action:{id:'idle'},sample:{fps:'fast'}}).status).toBe(400);
  expect(post({action:{id:'idle'},rig:7}).status).toBe(400);
  expect(post({action:{id:'idle',parameters:[]}}).status).toBe(400);
  expect(post({action:'idle'}).status).toBe(400);
 });
 it('replays identical responses for the same Idempotency-Key and rejects reuse with a different body',()=>{
  const key='test-key-1';
  const a=post({action:{id:'reach'}},{'idempotency-key':key});
  const b=post({action:{id:'reach'}},{'idempotency-key':key});
  expect(b.body).toEqual(a.body);
  const c=post({action:{id:'squat'}},{'idempotency-key':key});
  expect(c.status).toBe(409);
  expect((c.body as {error:{code:string}}).error.code).toBe('idempotency_conflict');
 });
 it('bounds the idempotency cache by count and TTL',()=>{
  for(let i=0;i<LIMITS_SVC.idempotencyMaxKeys+40;i++)post({action:{id:'idle'},sample:{fps:1}},{'idempotency-key':`fill-${i}`});
  expect(ctx.idempotent.size).toBeLessThanOrEqual(LIMITS_SVC.idempotencyMaxKeys);
  // Expired entries no longer conflict: an aged-out key accepts a new body.
  const stale=post({action:{id:'idle'},sample:{fps:1}},{'idempotency-key':'stale-key'});
  ctx.idempotent.get('stale-key')!.at=Date.now()-(LIMITS_SVC.idempotencyTtlSeconds+1)*1000;
  const fresh=post({action:{id:'squat'},sample:{fps:1}},{'idempotency-key':'stale-key'});
  expect(fresh.status).toBe(200);
 // Filling the cache runs ~300 real document solves — slower than the
 // pre-convergence baked-definition path, so this test gets the same room as
 // the HTTP smoke test.
 },30000);
});
describe('preconditions, parameters and idempotency keys',()=>{
 it('enforces a pinned revision or definition hash with 409',()=>{
  const cat=handleRequest(ctx,'GET','/v1/actions/idle').body as {revision:string;definitionSHA256:string};
  expect(cat.revision).toMatch(/^workshop-doc-[0-9a-f]{12}$/);
  expect(post({action:{id:'idle',revision:cat.revision,definitionSHA256:cat.definitionSHA256}}).status).toBe(200);
  const stale=post({action:{id:'idle',revision:'workshop-doc-000000000000'}});
  expect(stale.status).toBe(409);
  expect((stale.body as {error:{code:string}}).error.code).toBe('precondition_failed');
  expect(post({action:{id:'idle',definitionSHA256:'0'.repeat(64)}}).status).toBe(409);
  // Workshop documents are pinned by the workshop revision.
  const doc=blankDocument(ctx.rig.rest,'pin','pinned');
  expect(post({action:{id:'workshop-doc',revision:'workshop-doc/v1',parameters:{document:doc}}}).status).toBe(409);
 });
 it('rejects parameters a bundled action does not declare',()=>{
  const r=post({action:{id:'idle',parameters:{speed:2}}});
  expect(r.status).toBe(400);
  expect((r.body as {error:{code:string}}).error.code).toBe('invalid_request');
 });
 it('bounds Idempotency-Key length and alphabet',()=>{
  expect(post({action:{id:'idle'}},{'idempotency-key':'k'.repeat(LIMITS_SVC.idempotencyKeyMaxLength+1)}).status).toBe(400);
  expect(post({action:{id:'idle'}},{'idempotency-key':'has space'}).status).toBe(400);
  expect(post({action:{id:'idle'}},{'idempotency-key':'k'.repeat(LIMITS_SVC.idempotencyKeyMaxLength)}).status).toBe(200);
 });
});
describe('artifact identity and definition hashing',()=>{
 it('ties definitionSHA256 to the real envelope payload, not just id+revision',()=>{
  const h=(x:unknown)=>sha256(canonical(x));
  const file=motionFileById('forehand')!;
  const payload=()=>motionDefinitionPayload(file);
  // Every definition-bearing field moves the hash: the document's keys…
  const mutDoc=payload();const d=JSON.parse(JSON.stringify(file.document));
  d.keys[2].time+=.01;mutDoc.document=d;
  expect(h(mutDoc)).not.toBe(h(payload()));
  // …the phase annotations…
  expect(h({...payload(),phases:[...file.phases,{time:1,label:'x'}]})).not.toBe(h(payload()));
  // …and the provenance notes.
  expect(h({...payload(),notes:['changed']})).not.toBe(h(payload()));
  // Display-only envelope fields never enter the definition hash — the
  // payload shares the envelope's document by reference, so the served hash
  // is exactly the hash of what was normalized off disk.
  expect(h(motionDefinitionPayload({...file,description:'different'}))).toBe(h(payload()));
  const pkg=post({action:{id:'forehand'}}).body as PosePackage;
  expect(pkg.action.definitionSHA256).toBe(actionDefinitionHash(payload()));
  expect(pkg.action.definitionSHA256).not.toBe((post({action:{id:'squat'}}).body as PosePackage).action.definitionSHA256);
 });
 it('derives the artifact id from request + definition + rig + solver, stable per resolved content',()=>{
  const req={action:{id:'idle'},sample:{fps:5}};
  const a=post(req).body as PosePackage,b=post(req).body as PosePackage;
  expect(b.id).toBe(a.id);
  // The id is NOT the bare request fingerprint — it also covers the
  // definition, rig manifest and solver version.
  expect(a.id).not.toBe('mot_'+sha256(canonical(req)).slice(0,16));
  // The fingerprint covers the normalized request, so spelling out the
  // defaults (empty parameters, the default output) does not change it.
  const fp=sha256(canonical(normalizedRequest('idle',undefined,5)));
  expect(a.provenance.requestFingerprint).toBe(fp);
  const spelled=post({action:{id:'idle',parameters:{}},outputs:[{kind:'motion',format:'pose-json'}],sample:{fps:5}}).body as PosePackage;
  expect(spelled.id).toBe(a.id);
  const doc=blankDocument(ctx.rig.rest,'v','doc-a');
  const c=post({action:{id:'workshop-doc',parameters:{document:doc}}}).body as PosePackage;
  const changed=blankDocument(ctx.rig.rest,'v','doc-a');changed.keys[0].pose.lean=7;
  const d=post({action:{id:'workshop-doc',parameters:{document:changed}}}).body as PosePackage;
  expect(d.id).not.toBe(c.id);
  expect(d.action.definitionSHA256).not.toBe(c.action.definitionSHA256);
 });
 it('yields a new artifact id when the solver, rig or definition changes',()=>{
  const req={action:{id:'idle'},sample:{fps:5}};
  const served=post(req).body as PosePackage;
  const fp=sha256(canonical(normalizedRequest('idle',undefined,5))),def=served.action.definitionSHA256;
  expect(artifactId(fp,def,ctx,'workshop-hermite-fk-ik')).toBe(served.id);
  expect(artifactId(fp,def,ctx,'workshop-hermite-fk-ik-v2')).not.toBe(served.id);
  expect(artifactId(fp,'0'.repeat(64),ctx,'workshop-hermite-fk-ik')).not.toBe(served.id);
  const otherRig={...ctx,manifest:{...ctx.manifest,manifestSHA256:'f'.repeat(64)}};
  expect(artifactId(fp,def,otherRig,'workshop-hermite-fk-ik')).not.toBe(served.id);
 });
});
describe('HTTP transport smoke',()=>{
 it('exercises the real serve.ts transport: gzip bodies decode, bad encodings 400, decompressed cap 413',async()=>{
  const port=8900+Math.floor(Math.random()*400);
  const npx=process.platform==='win32'?'npx.cmd':'npx';
  const proc=spawn(npx,['tsx','apps/server/src/serve.ts'],{
   env:{...process.env,HUMAN3D_PORT:String(port),HUMAN3D_ASSETS:path.resolve('public')},stdio:['ignore','pipe','pipe']});
  let bootLog='';proc.stdout.on('data',d=>bootLog+=d);proc.stderr.on('data',d=>bootLog+=d);
  try{
   let up=false;
   for(let i=0;i<300&&!up;i++){try{up=(await fetch(`http://127.0.0.1:${port}/v1/capabilities`)).ok;}catch{await new Promise(r=>setTimeout(r,200));}}
   expect(up,bootLog).toBe(true);
   const call=(body:Buffer,enc?:string)=>fetch(`http://127.0.0.1:${port}/v1/motions`,
    {method:'POST',headers:{'content-type':'application/json',...(enc?{'content-encoding':enc}:{})},body:Uint8Array.from(body)});
   const ok=await call(zlib.gzipSync(JSON.stringify({action:{id:'idle'},sample:{fps:2}})),'gzip');
   expect(ok.status).toBe(200);
   expect(((await ok.json()) as PosePackage).kind).toBe('pose-package');
   expect((await call(Buffer.from('definitely not gzip'),'gzip')).status).toBe(400);
   expect((await call(zlib.gzipSync(JSON.stringify({action:{id:'idle'},pad:'x'.repeat(1.5*1024*1024)})),'gzip')).status).toBe(413);
   expect((await call(Buffer.from('{}'),'br')).status).toBe(400);
   // Guards against DNS rebinding and cross-site POSTs. node:http is used so
   // the Host header can be set explicitly (fetch treats it as forbidden).
   const raw=(headers:Record<string,string>,method='GET',p='/v1/capabilities',body?:string)=>new Promise<number>((resolve,reject)=>{
    const rq=http.request({host:'127.0.0.1',port,path:p,method,headers},rs=>{rs.resume();rs.on('end',()=>resolve(rs.statusCode??0));});
    rq.on('error',reject);rq.end(body);
   });
   expect(await raw({host:'evil.example:8788'})).toBe(403);
   expect(await raw({host:`127.0.0.1:${port}`,origin:'http://evil.example'})).toBe(403);
   expect(await raw({host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`})).toBe(200);
   expect(await raw({host:`127.0.0.1:${port}`,'content-type':'text/plain'},'POST','/v1/motions','{}')).toBe(415);
  }finally{proc.kill('SIGTERM');}
 },60000);
 it('serves capabilities and a motion over a real socket on an ephemeral port',async()=>{
  const server=http.createServer((req,res)=>{
   let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const out=handleRequest(ctx,req.method??'GET',new URL(req.url??'/','http://x').pathname,raw?JSON.parse(raw):undefined,{});
    const data=JSON.stringify(out.body);
    res.writeHead(out.status,{'content-type':'application/json'});res.end(data);
   });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port;
  try{
   const caps=await (await fetch(`http://127.0.0.1:${port}/v1/capabilities`)).json() as {service:{name:string}};
   expect(caps.service.name).toBe('human3d-motion');
   const res=await fetch(`http://127.0.0.1:${port}/v1/motions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:{id:'idle'},sample:{fps:5}})});
   expect(res.status).toBe(200);
   const pkg=await res.json() as PosePackage;
   expect(validatePosePackage(pkg,ctx.manifest)).toEqual([]);
  }finally{await new Promise(r=>server.close(r));}
 });
});
