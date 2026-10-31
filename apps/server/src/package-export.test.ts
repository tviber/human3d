import {describe,it,expect,beforeAll,vi} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from '@human3d/motion-core';
import {buildManifestLocal,buildPosePackageLocal,subtleDigest,type PackageEnv} from '@human3d/motion-core';
import {canonical,WORKSHOP_REVISION,solveWorkshop,workshopMeta,validatePosePackage,type RigManifest} from '@human3d/motion-core';
import type {PosePackage} from '@human3d/motion-core';
import {sha256} from './rig-manifest';
import {createService,handleRequest,type ServiceContext} from './service';
import {blankDocument,defaultDocument,serializeDoc,rotateHandFrame,frameAt,solveEffectiveFrame} from '@human3d/motion-core';
import {mulberry32,randomDoc} from '@human3d/motion-core';

/** Peer-parity contract: the browser-side builder (buildPosePackageLocal)
 * must produce the exact bodies POST /v1/motions {workshop-doc} serves —
 * package bytes, artifact id, fingerprint, tracks, events, quality and error
 * details — with hashing swapped from node:crypto to crypto.subtle. Every
 * case runs both real paths (parseDoc → solveWorkshop → validatePosePackage
 * vs handleRequest) on the same wire document and compares the full body. */
let rig:HumanRig,ctx:ServiceContext,manifest:RigManifest;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const rigJsonBytes=fs.readFileSync('public/models/rig.json'),rigJson=JSON.parse(rigJsonBytes.toString('utf8'));
 rig=new HumanRig(gltf.scene,rigJson);
 // The browser-side manifest build (WebCrypto digest) must equal the
 // service's node:crypto assembly — asserted against ctx.manifest below.
 manifest=await buildManifestLocal(rigJson,sha256(rigJsonBytes));
 ctx=await createService('public');
},30000);

const env=():PackageEnv=>({rig,manifest}); // digest defaults to crypto.subtle
const serve=(document:unknown,fps=40)=>
 handleRequest(ctx,'POST','/v1/motions',{action:{id:'workshop-doc',parameters:{document}},sample:{fps}});
const local=(document:unknown,fps=40)=>buildPosePackageLocal(document,fps,env());
const wire=(d:Parameters<typeof serializeDoc>[0])=>JSON.parse(serializeDoc(d));

/** Run one document through both paths and require identical status+body. */
async function parity(document:unknown,fps=40){
 const served=serve(document,fps),built=await local(document,fps);
 expect(built.status).toBe(served.status);
 expect(built.body).toEqual(served.body);
 return {served,built};
}

describe('WebCrypto digest parity',()=>{
 it('subtleDigest hashes canonical JSON byte-identically to node:crypto',async()=>{
  const s=canonical({schema:WORKSHOP_REVISION,document:{b:2,a:[1.5,'x'],n:{z:true,y:null}}});
  await expect(subtleDigest(s)).resolves.toBe(sha256(s));
  // The session manifest built through WebCrypto equals the service's.
  expect(manifest.manifestSHA256).toBe(ctx.manifest.manifestSHA256);
 });
 it('refuses to fabricate a hash when crypto.subtle is unavailable',async()=>{
  vi.stubGlobal('crypto',undefined);
  try{
   await expect(buildPosePackageLocal(wire(blankDocument(rig.rest,'d','d')),40,env()))
    .rejects.toThrow(/https 或 localhost/);
  }finally{vi.unstubAllGlobals();}
 });
});

describe('peer parity — document shapes',()=>{
 it('free-arm authoring delivers the unclamped wrist on both peers',async()=>{
  const d=blankDocument(rig.rest,'自由手臂','free-arms');d.freeArms=true;
  d.keys.forEach(k=>rotateHandFrame(k.pose.handR,'flex',150));
  const free=await parity(wire(d));
  expect(free.served.status).toBe(200);
  delete d.freeArms;
  const bounded=await parity(wire(d));
  expect(bounded.served.status).toBe(200);
  expect((free.built.body as PosePackage).tracks).not.toEqual((bounded.built.body as PosePackage).tracks);
 });
 it('free elbows beyond the ordinary limit remain rejected by the delivery gate',async()=>{
  const d=blankDocument(rig.rest,'自由肘','free-elbow');d.freeArms=true;
  solveEffectiveFrame(rig,frameAt(d,0,rig.rest.get('root')!));
  const shoulder=rig.point('upperarm01_R');
  d.keys.forEach(k=>{k.pose.handR.target={x:shoulder.x,y:shoulder.y-.08,z:shoulder.z};});
  const {built}=await parity(wire(d));
  expect(built.status).toBe(422);
  expect((built.body as {error:{details:string[]}}).error.details.some(e=>e.includes('elbow flexion'))).toBe(true);
 });
 it('rejects a free-arm elbow pose even if presentation metadata is added after solving',()=>{
  const d=blankDocument(rig.rest,'自由肘','free-elbow');d.freeArms=true;
  solveEffectiveFrame(rig,frameAt(d,0,rig.rest.get('root')!));
  const shoulder=rig.point('upperarm01_R');
  d.keys.forEach(k=>{k.pose.handR.target={x:shoulder.x,y:shoulder.y-.08,z:shoulder.z};});
  const pkg=solveWorkshop(rig,d,40,workshopMeta({motionId:'mot_tampered-presentation',
   manifestSHA256:manifest.manifestSHA256,bones:manifest.bones.length,actionId:'workshop-doc',
   revision:WORKSHOP_REVISION,definitionSHA256:'test-definition',documentName:d.name,
   source:'test',license:'test',requestFingerprint:'test',fps:40,duration:d.duration,keys:d.keys.length}));
  pkg.action.parameters.presentation={freeArms:true};
  expect(validatePosePackage(pkg,manifest).some(e=>e.includes('elbow flexion'))).toBe(true);
 });
 it('defaultDocument',()=>parity(wire(defaultDocument(rig.rest))));
 it('pelvis handFrames with rotated pelvis',()=>{
  const d=blankDocument(rig.rest,'骨盆系','pelvis-frames');
  d.keys[0].pose.yaw=38;d.keys[1].pose.yaw=-20;
  d.handFrames={L:'pelvis',R:'pelvis'};
  return parity(wire(d));
 });
 it('loop:true document',()=>{
  const d=blankDocument(rig.rest,'循环','loop-doc');
  d.loop=true;d.duration=1.2;
  return parity(wire(d));
 });
 it('inbetweens:false document',()=>{
  const d=blankDocument(rig.rest,'阶梯','stepped');
  d.inbetweens=false;
  return parity(wire(d));
 });
 it('unicode document name',()=>{
  return parity(wire(blankDocument(rig.rest,'正手·挥拍🎾','uni-doc')));
 });
 it('left-grip document carries the side end to end',async()=>{
  const d=blankDocument(rig.rest,'左持拍','left-grip');
  d.gripSide='L';d.gripBevel=4;d.gripTilt=17.5;d.keys.forEach(k=>{k.constraints.grip=true;});
  const {built}=await parity(wire(d));
  expect((built.body as PosePackage).action.parameters)
   .toEqual({documentName:'左持拍',presentation:{prop:'racket',gripSide:'L',bevel:4,gripTilt:17.5,loop:false}});
 });
 it('fps 1 and fps 7 (non-integer duration×fps grids)',async()=>{
  await parity(wire(defaultDocument(rig.rest)),1);
  await parity(wire(blankDocument(rig.rest,'短','short')),7);
 });
});

describe('peer parity — rejection bodies',()=>{
 it('422 details equal the service error.details verbatim',async()=>{
  const req=JSON.parse(fs.readFileSync('spec/examples/rejected-pelvis-fold.request.json','utf8'));
  const {served,built}=await parity(req.action.parameters.document,req.sample?.fps??40);
  expect(served.status).toBe(422);
  expect((built.body as {error:{details:string[]}}).error.details)
   .toEqual((served.body as {error:{details:string[]}}).error.details);
 });
 it('oversized documents get the service 400 body',async()=>{
  const d=blankDocument(rig.rest,'超长','long-doc');
  d.duration=99; // past WORKSHOP_LIMITS.maxDuration — parseDoc refuses first
  await parity(wire(d));
 });
 it('double fault: out-of-range fps refuses before the document is read',async()=>{
  // The service's contract layer carries the fps bound and runs before
  // parseDoc — a malformed document plus bad fps must answer
  // invalid_request on both sides (the local fps check precedes parseDoc).
  // Bodies differ: the service's message comes from Ajv, the builder's is
  // its own — the shared claim is status + error.code.
  const malformed={not:'a workshop document'};
  const served=serve(malformed,99),built=await local(malformed,99);
  expect(served.status).toBe(400);
  expect(built.status).toBe(served.status);
  expect((built.body as {error:{code:string}}).error.code)
   .toBe((served.body as {error:{code:string}}).error.code);
  expect((built.body as {error:{code:string}}).error.code).toBe('invalid_request');
 });
});

describe('ad-hoc action.parameters presentation',()=>{
 it('marks prop for grip documents and loop for looping ones',async()=>{
  const {built}=await parity(wire(defaultDocument(rig.rest)));
  const params=(built.body as PosePackage).action.parameters;
  expect(params).toEqual({documentName:'正手挥拍 · 工作区',presentation:{prop:'racket',loop:false}});
  const d=blankDocument(rig.rest,'循环','loop-doc');d.loop=true;d.duration=1.2;
  const noGrip=await buildPosePackageLocal(wire(d),40,env());
  expect((noGrip.body as PosePackage).action.parameters)
   .toEqual({documentName:'循环',presentation:{loop:true}});
 });
 it('a cached env yields identical packages across calls',async()=>{
  const e=env(),doc=wire(defaultDocument(rig.rest));
  const a=await buildPosePackageLocal(doc,40,e),b=await buildPosePackageLocal(doc,40,e);
  expect(b).toEqual(a);
  expect(a.status).toBe(200);
 });
});

describe('peer parity — seeded random documents',()=>{
 /* randomDoc draws inside the validated domain, but honest random poses
  * mostly trip the semantic validator — the draw is rejection-heavy, not
  * 200-tuned (seed 11: 0/8 succeed; seed 23: 1/8). Every draw still runs the
  * full parity: status and body must match whatever the service answers,
  * and a 422 must carry its error.details verbatim — those strings are the
  * diagnostics the workshop card renders. A deterministic-200 anchor doc
  * rides along so the success side is exercised every run, whatever the
  * draw produces. */
 for(const seed of [11,23])
  it(`seed ${seed}: every drawn document gets status+body parity, 422 details verbatim`,async()=>{
   const rng=mulberry32(seed);
   const docs=[wire(defaultDocument(rig.rest))]; // service-200 anchor
   for(let di=0;di<8;di++)docs.push(wire(randomDoc(rng,ctx.rig.rest)));
   const tally:Record<number,number>={};
   for(const doc of docs){
    const {served,built}=await parity(doc);
    tally[served.status]=(tally[served.status]??0)+1;
    if(served.status===422){
     const details=(served.body as {error:{details:string[]}}).error.details;
     expect(details.length).toBeGreaterThan(0);
     expect((built.body as {error:{details:string[]}}).error.details).toEqual(details);
    }
   }
   // Both sides of the gate must have been compared — the old `continue`
   // on non-200 let a full-skip seed pass while comparing nothing.
   expect(tally[200]).toBeGreaterThan(0);
   expect(tally[422]).toBeGreaterThan(0);
  },60000);
});
