import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {AnimationClip,AnimationMixer,Group,Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from '@human3d/motion-core';
import {attachRacket,mountRacket} from '@human3d/motion-core';
import {checkPosePackageShape,posePackageSpec,rigMatches} from '@human3d/motion-core';
import {ClipSource,createDynamicsSession,DocumentSource,DynamicsSource,PosePackageSource} from './motion-source';
import {motionDefinitionPayload,normalizeMotionFile} from '@human3d/motion-core';
import {motionFileById} from '@human3d/motion-core';
import {buildPosePackageLocal,subtleDigest} from '@human3d/motion-core';
import {buildRigManifest,sha256} from '@human3d/server/rig-manifest';
import {actionDefinitionHash,createService,handleRequest,type ServiceContext} from '@human3d/server';
import {blankDocument,defaultDocument,serializeDoc} from '@human3d/motion-core';
import type {DynamicsReplay} from '../lab/dynamics';
import {solveWorkshop,type PosePackage} from '@human3d/motion-core';
import {WORKSHOP_REVISION,workshopMeta,type RigManifest} from '@human3d/motion-core';

/* MotionSource coverage: the package shape gate on the golden artifact and on
 * broken copies, the reference decoder cross-proved against an independent
 * manifest FK walk (the same math measurePackage uses, extended to arbitrary
 * times — no shared decode code), and smoke coverage for the document and
 * clip sources through their real seek paths. */
let rig:HumanRig,manifest:RigManifest,golden:PosePackage,racket:Group,ctx:ServiceContext;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const rigJson=JSON.parse(fs.readFileSync('public/models/rig.json','utf8'));
 rig=new HumanRig(gltf.scene,rigJson);
 racket=attachRacket(rig);
 manifest=buildRigManifest(rigJson,sha256(fs.readFileSync('public/models/rig.json')));
 golden=JSON.parse(fs.readFileSync('spec/examples/idle.pose.json','utf8'));
 ctx=await createService('public');
},60000);

const validBones=()=>new Set(rig.bones.keys());
const clone=<T,>(x:T):T=>JSON.parse(JSON.stringify(x));

describe('checkPosePackageShape',()=>{
 it('accepts the golden idle package',()=>{
  expect(checkPosePackageShape(golden,validBones())).toEqual([]);
  expect(checkPosePackageShape(golden)).toEqual([]);
 });
 it('points editable-action and library-backup JSON to their matching import flows',()=>{
  const action=blankDocument(rig.rest,'跨设备动作','cross-device-action');
  expect(checkPosePackageShape(action)).toEqual([
   '这是可编辑动作 JSON，不是姿态包；请在动作工作台用「导入动作」导入。实验室播放请从工作台导出 .pose.json 姿态包。',
  ]);
  expect(checkPosePackageShape({kind:'workshop-motion',document:action})).toEqual([
   '这是可编辑动作 JSON，不是姿态包；请在动作工作台用「导入动作」导入。实验室播放请从工作台导出 .pose.json 姿态包。',
  ]);
  expect(checkPosePackageShape({kind:'h3d-library-backup'})).toEqual([
   '这是动作库整库备份，不是姿态包；请在动作工作台用「恢复备份」导入。',
  ]);
 });
 it('rejects each broken copy with a readable problem',()=>{
  const cases:[string,(p:PosePackage)=>void,RegExp][]=[
   ['末时间戳不等于 duration',p=>{p.timeline.duration+=.5;},/末时间戳/],
   ['timestamps 乱序',p=>{const t=p.timeline.timestamps;[t[5],t[6]]=[t[6],t[5]];},/严格递增/],
   ['rotation values 长度',p=>{p.tracks.rotations[0].values=p.tracks.rotations[0].values.slice(0,-4);},/count×4/],
   ['未知 bone',p=>{p.tracks.rotations[0].bone='no_such_bone';},/rig 外的骨骼/],
   ['schemaVersion',p=>{(p as {schemaVersion:number}).schemaVersion=3;},/schemaVersion/],
   // events / metadata-element gates: well-formed packages carry them, so a
   // malformed copy must be refused with a readable reason.
   ['events 非数组',p=>{(p as unknown as {events:unknown}).events=42;},/events 必须是数组/],
   ['events 元素非对象',p=>{(p as unknown as {events:unknown}).events=[null];},/events 元素必须是对象/],
   ['events.type 非法',p=>{(p.events as {type:string}[])[0].type='bounce';},/type 非法/],
   ['events.time 非有限数',p=>{(p.events as {time:number}[])[0].time=NaN;},/time/],
   ['events.label 缺失',p=>{(p.events as {label?:string}[])[0].label=undefined;},/label/],
   ['support-start 缺 side',p=>{p.events.push({time:0,label:'x',type:'support-start'});},/side/],
   ['support-end side 非法',p=>{p.events.push({time:0,label:'x',type:'support-end',side:'X' as 'L'});},/side/],
   ['rig.id 不符',p=>{p.rig.id='other-rig';},/rig\.id/],
   ['rig.manifestSHA256 非字符串',p=>{(p.rig as {manifestSHA256:unknown}).manifestSHA256=42;},/manifestSHA256/],
   ['action.id 非字符串',p=>{(p.action as {id:unknown}).id=42;},/action\.id/],
   ['quality.warnings 非字符串数组',p=>{(p.quality as {warnings:unknown}).warnings=[7];},/quality\.warnings/],
   ['provenance.solver 非字符串',p=>{(p.provenance as {solver:unknown}).solver=7;},/provenance\.solver/],
   // Round-2 additions: duplicate bone tracks are last-write-wins ambiguity;
   // every sample's quaternion must be unit (validate.ts tolerance); the
   // declared count is capped by ⌈duration·fps⌉+1 on the package's own
   // declared fps (240 outer bound when absent) plus an absolute bound.
   ['重复 bone 轨道',p=>{p.tracks.rotations.push(clone(p.tracks.rotations[0]));},/重复旋转轨/],
   ['非单位四元数',p=>{const v=p.tracks.rotations[0].values;for(let i=0;i<4;i++)v[i]*=2;},/非单位/],
   ['全零四元数',p=>{p.tracks.rotations[0].values.splice(0,4,0,0,0,0);},/非单位/],
   ['NaN 四元数',p=>{p.tracks.rotations[0].values[0]=NaN;},/非有限/],
   ['count 超密度上限',p=>{p.timeline.duration=.5;},/密度上限/],
   ['count 超绝对上限',p=>{p.timeline.count=200_001;},/绝对上限/],
  ];
  for(const [name,mutate,pattern]of cases){
   const p=clone(golden);mutate(p);
   const errs=checkPosePackageShape(p,validBones());
   expect(errs.length,`${name}: expected problems`).toBeGreaterThan(0);
   expect(errs.join('|'),`${name}: expected a matching message`).toMatch(pattern);
  }
 });
 it('admits the densest package the real sampling grid produces (⌈duration·fps⌉+1)',()=>{
  // The density gate must not reject what a real builder emits: 0.502 s is
  // not 1/240-aligned, so the uniform grid tops out at 0.5 and the appended
  // exact endpoint brings count to ⌈0.502×240⌉+1 = 122 — the previous flat
  // duration×240+1 bound off-by-oned this package (121.48 < 122).
  const doc=blankDocument(rig.rest,'密度边界','density-edge');
  doc.duration=.502;doc.keys[1].time=.502;
  const pkg=solveWorkshop(rig,doc,240,workshopMeta({
   motionId:'mot_test-density',manifestSHA256:manifest.manifestSHA256,bones:manifest.bones.length,
   actionId:'workshop-doc',revision:WORKSHOP_REVISION,definitionSHA256:'test-definition',
   documentName:doc.name,prop:false,loop:doc.loop,
   source:'motion-source.test',license:'test',requestFingerprint:'test',
   fps:240,duration:doc.duration,keys:doc.keys.length}));
  expect(pkg.timeline.count).toBe(122);
  expect(checkPosePackageShape(pkg,validBones())).toEqual([]);
 });
 it('the density cap follows the declared fps, not just the 240 ceiling',()=>{
  // Declaring fps=60 while carrying a timeline only a denser grid could
  // produce is inconsistent data — the cap binds the declared grid.
  const p=clone(golden);p.timeline.fps=60;p.timeline.duration=.5;
  expect(checkPosePackageShape(p).join('|')).toMatch(/密度上限/);
 });
 it('a package with null events is refused by the decoder while the spec derivation stays total',()=>{
  const p=clone(golden);(p as unknown as {events:unknown}).events=[null];
  expect(checkPosePackageShape(p,validBones()).length).toBeGreaterThan(0);
  expect(new PosePackageSource(rig,p).status).toBe('error');
  // Deep defence: standalone spec derivation must not throw on the same
  // input — the isObj guard drops non-object events before the type reads.
  const spec=posePackageSpec(p,'pkg:test');
  expect(spec.phases).toEqual([]);
 });
 it('drops half-baked event objects instead of emitting undefined fields into phases',()=>{
  const p=clone(golden);
  // `{type:'phase'}` without time/label passes a bare isObj check — the
  // standalone spec filter must not leak it as {time:undefined,label:undefined}.
  (p as unknown as {events:unknown}).events=[{type:'phase'},{type:'keyframe',time:.5,label:'ok'}];
  expect(checkPosePackageShape(p,validBones()).length).toBeGreaterThan(0); // shape gate still refuses it
  const spec=posePackageSpec(p,'pkg:test');       // standalone derivation stays total
  expect(spec.phases).toEqual([{time:.5,label:'ok'}]);
 });
 it('fails closed on a non-object package',()=>{
  expect(checkPosePackageShape('nope').length).toBeGreaterThan(0);
  expect(new PosePackageSource(rig,42).status).toBe('error');
 });
});

/** Independent FK re-walk of a package at an arbitrary time: manifest rest
 * translations + delivered local rotations slerped between bracketing
 * samples. Mirrors measurePackage's traversal (restLocalT from bone heads,
 * identity for untracked bones) — a second implementation, so agreement with
 * PosePackageSource's three.js decode is a real cross-check. */
function fkWorldAt(pkg:PosePackage,t:number){
 const byBone=new Map(manifest.bones.map(b=>[b.name,b]));
 const headOf=(n:string)=>new Vector3(...(byBone.get(n)!.head as [number,number,number]));
 const restLocalT=(n:string)=>{const b=byBone.get(n)!;return b.parent?headOf(n).sub(headOf(b.parent)):headOf(n);};
 const tracks=new Map(pkg.tracks.rotations.map(tr=>[tr.bone,tr.values]));
 const ts=pkg.timeline.timestamps,count=ts.length,T=pkg.tracks.translation.values;
 let lo=0,hi=count-1;
 const time=Math.max(0,Math.min(pkg.timeline.duration,t));
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ts[mid]<=time)lo=mid;else hi=mid-1;}
 const i=lo,j=Math.min(i+1,count-1),dt=ts[j]-ts[i],u=dt>1e-9?(time-ts[i])/dt:0;
 const wq=new Map<string,Quaternion>(),wp=new Map<string,Vector3>();
 const qa=new Quaternion(),qb=new Quaternion();
 for(const b of manifest.bones){
  const v=tracks.get(b.name);
  const lq=v?qa.fromArray(v,i*4).clone().slerp(qb.fromArray(v,j*4),u):new Quaternion();
  if(!b.parent){
   wq.set(b.name,lq);
   wp.set(b.name,new Vector3(T[i*3]+(T[j*3]-T[i*3])*u,T[i*3+1]+(T[j*3+1]-T[i*3+1])*u,T[i*3+2]+(T[j*3+2]-T[i*3+2])*u));
  }else{
   const pq=wq.get(b.parent)!,pp=wp.get(b.parent)!;
   wq.set(b.name,pq.clone().multiply(lq));
   wp.set(b.name,restLocalT(b.name).applyQuaternion(pq).add(pp));
  }
 }
 return wp;
}

describe('PosePackageSource — reference decoder',()=>{
 it('decodes the golden package to the same world positions an independent FK walk computes',()=>{
  const src=new PosePackageSource(rig,golden);
  expect(src.status).toBe('ready');
  const D=golden.timeline.duration;
  // Grid points and off-grid times, including one past the end (clamped).
  const times=[0,.0137,.0375,.5,1.111,2.2,D/2,D-.001,D,D+.4];
  for(const t of times){
   src.seek(t);
   const wp=fkWorldAt(golden,t);
   let worst=0,worstBone='';
   for(const b of manifest.bones){
    const d=rig.point(b.name).distanceTo(wp.get(b.name)!);
    if(d>worst){worst=d;worstBone=b.name;}
   }
   expect(worst,`t=${t} worst bone ${worstBone}`).toBeLessThan(1e-6);
   const rd=src.rootPoint().distanceTo(wp.get('root')!);
   expect(rd,`t=${t} root`).toBeLessThan(1e-6);
  }
 });
 it('exposes diagnostics and never wants the prop without a hint',()=>{
  const src=new PosePackageSource(rig,golden);
  src.seek(.5);
  const d=src.diagnostics();
  expect(d).not.toBeNull();
  expect(Number.isFinite(d!.knee)).toBe(true);
  expect(d!.bones).toBe(rig.bones.size);
  expect(src.wantsProp()).toBe(false);
 });
});

/* openPosePackage's spec derivation (engine.ts): the package alone must
 * reconstruct the lab entry — bundled envelopes by action.id, the ad-hoc
 * action.parameters presentation channel, phase/keyframe events as timeline
 * markers, and the authored loop flag as oneShot. Both construction paths
 * are real: bundled packages come from the service's own handleRequest,
 * ad-hoc packages from buildPosePackageLocal (peer-parity-pinned against the
 * service). No fabricated package shapes. */
describe('posePackageSpec — bundled envelope restore',()=>{
 const served=(id:string)=>handleRequest(ctx,'POST','/v1/motions',{action:{id}}).body as PosePackage;
 it('a served forehand package restores capabilities, name, phases and oneShot',()=>{
  const file=motionFileById('forehand')!;
  const pkg=served('forehand');
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.name).toBe(file.name);            // 正手挥拍 — not the bare 'forehand' id
  expect(spec.english).toBe(file.english);
  expect(spec.method).toBe(file.method);
  expect(spec.focus).toEqual(file.focus);
  // The prop capability is what remounts the racket in the lab.
  expect(spec.capabilities?.prop).toEqual({kind:'racket',trail:true,handView:true});
  // Envelope phases are delivered as 'phase' events and map back verbatim.
  expect(spec.phases).toEqual(file.phases);
  // forehand's document is authored loop:false → one-shot replay.
  expect(spec.oneShot).toBe(true);
  // The honesty surface: solver provenance and the warnings the package
  // carries are visible in the description, not dropped on the floor.
  expect(pkg.quality.warnings.length).toBeGreaterThan(0);
  expect(spec.description).toContain(pkg.provenance.solver);
  expect(spec.description).toContain(`质量警告 ${pkg.quality.warnings.length} 条`);
  expect(spec.description).toContain('research-reference');
  expect(spec.description).toContain('常量显示');
 });
 it('the derived prop hint drives wantsProp and the grip readout',()=>{
  const pkg=served('forehand');
  const spec=posePackageSpec(pkg,'pkg:test');
  const src=new PosePackageSource(rig,pkg,spec.capabilities?.prop,racket);
  expect(src.status).toBe('ready');
  src.seek(2.55);
  expect(src.wantsProp()).toBe(true);
  // The mount is rigid, so the measured grip offset is a real ~0, not a stub.
  const d=src.diagnostics()!;
  expect(Number.isFinite(d.gripError)).toBe(true);
  expect(d.gripError).toBeLessThan(1e-6);
  // No hint → constant false, diagnostics report no grip error.
  const bare=new PosePackageSource(rig,pkg);
  bare.seek(2.55);
  expect(bare.wantsProp()).toBe(false);
  expect(bare.diagnostics()!.gripError).toBe(0);
 });
 it('envelope fields win over a forged ad-hoc parameters channel',()=>{
  const pkg=clone(served('idle'));
  pkg.action.parameters={documentName:'伪造名',presentation:{loop:true,prop:'racket'}};
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.name).toBe('自然站立');            // envelope > parameters
  expect(spec.oneShot).toBe(true);              // envelope document.loop wins over presentation.loop
  expect(spec.capabilities?.prop).toBeUndefined(); // idle's envelope declares no prop
 });
 it('an unknown action id falls back to the id itself and stays loopable',()=>{
  const pkg=clone(golden);
  pkg.action.id='teleport';
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.name).toBe('teleport');
  expect(spec.english).toBe('POSE PACKAGE');
  expect(spec.capabilities).toBeUndefined();
  expect(spec.oneShot).toBeUndefined();
  expect(spec.phases).toEqual(motionFileById('idle')!.phases); // phase events carry through
 });
});

describe('posePackageSpec — ad-hoc presentation channel',()=>{
 const local=async(d:Parameters<typeof serializeDoc>[0]):Promise<PosePackage>=>{
  const res=await buildPosePackageLocal(JSON.parse(serializeDoc(d)),40,{rig,manifest,digest:subtleDigest});
  if(res.status!==200)throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
 };
 it('derives name, prop capability and oneShot from parameters.presentation',async()=>{
  const doc=defaultDocument(rig.rest); // grip keys → presentation.prop:'racket'
  const pkg=await local(doc);
  expect(pkg.action.parameters).toEqual({documentName:doc.name,presentation:{prop:'racket',loop:false}});
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.name).toBe(doc.name);
  expect(spec.english).toBe('POSE PACKAGE');
  expect(spec.capabilities?.prop).toEqual({kind:'racket',trail:true,handView:true});
  expect(spec.oneShot).toBe(true);
  // No phase events in an ad-hoc package → keyframe events mark the timeline.
  expect(pkg.events.some(e=>e.type==='phase')).toBe(false);
  expect(spec.phases).toEqual(pkg.events.filter(e=>e.type==='keyframe').map(({time,label})=>({time,label})));
  expect(spec.phases.length).toBe(doc.keys.length);
  expect(spec.description).toContain('常量显示');
 });
 it('carries grip bevel and shaft tilt into the prop hint; canonical values stay absent',async()=>{
  const doc=blankDocument(rig.rest,'换棱面','bevel-grip');
  doc.keys.forEach(k=>{k.constraints.grip=true;});
  const plain=await local(doc);
  expect((plain.action.parameters as {presentation:Record<string,unknown>}).presentation).not.toHaveProperty('bevel');
  expect(posePackageSpec(plain,'pkg:test').capabilities?.prop).not.toHaveProperty('bevel');
  doc.gripBevel=6;
  const pkg=await local(doc);
  expect(pkg.action.parameters).toEqual({documentName:'换棱面',presentation:{prop:'racket',bevel:6,loop:false}});
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.capabilities?.prop).toEqual({kind:'racket',trail:true,handView:true,bevel:6});
  const src=new PosePackageSource(rig,pkg,spec.capabilities?.prop,racket);
  expect(src.propBevel).toBe(6);
  doc.gripTilt=17.5;
  const tiltedPkg=await local(doc),tiltedSpec=posePackageSpec(tiltedPkg,'pkg:test');
  expect(tiltedPkg.action.parameters).toEqual({documentName:'换棱面',presentation:{prop:'racket',bevel:6,gripTilt:17.5,loop:false}});
  expect(tiltedSpec.capabilities?.prop?.gripTilt).toBe(17.5);
  const tiltedSrc=new PosePackageSource(rig,tiltedPkg,tiltedSpec.capabilities?.prop,racket);
  expect(tiltedSrc.propGripTilt).toBe(17.5);
 });
 it('carries gripSide into the prop side hint and the mount readout',async()=>{
  const doc=blankDocument(rig.rest,'左持拍','left-grip');
  doc.gripSide='L';doc.keys.forEach(k=>{k.constraints.grip=true;});
  const pkg=await local(doc);
  expect(pkg.action.parameters).toEqual({documentName:'左持拍',presentation:{prop:'racket',gripSide:'L',loop:false}});
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.capabilities?.prop).toEqual({kind:'racket',trail:true,handView:true,side:'L'});
  expect(spec.description).toContain('左手持拍');
  // The real mount path on the shared racket: remount left, measure the grip
  // error against the LEFT wrist, then restore the canonical right mount.
  mountRacket(rig,racket,'L');
  const src=new PosePackageSource(rig,pkg,spec.capabilities?.prop,racket);
  expect(src.propSide).toBe('L');
  src.seek(.5);
  expect(src.wantsProp()).toBe(true);
  expect(src.diagnostics()!.gripError).toBeLessThan(1e-6);
  mountRacket(rig,racket,'R');
 });
 it('presentation.loop:true yields a loopable spec; no grip leaves the prop absent',async()=>{
  const doc=blankDocument(rig.rest,'循环','loop-doc');
  doc.loop=true;doc.duration=1.2;
  const pkg=await local(doc);
  expect(pkg.action.parameters).toEqual({documentName:'循环',presentation:{loop:true}});
  const spec=posePackageSpec(pkg,'pkg:test');
  expect(spec.oneShot).toBe(false);
  expect(spec.capabilities).toBeUndefined();
  const src=new PosePackageSource(rig,pkg,spec.capabilities?.prop,racket);
  src.seek(.6);
  expect(src.wantsProp()).toBe(false);
 });
});

/* DynamicsSource's load is two awaits deep (module fetch, then the record);
 * the engine can switch sources or start a newer load in between. The gen
 * counter must retire the stale continuation so a late resolution cannot
 * resurrect the replay (root.visible/status) over whoever owns the session
 * now. The session promise is injected with a fake replay — the source under
 * test is load's own guard logic, not DynamicsReplay.create. */
describe('DynamicsSource — load supersession',()=>{
 const fakeReplay=()=>{
  const root=new Group();root.visible=false; // mirrors the real constructor
  return {root,duration:2.5,ready:true,
   load:async()=>true,seek(){},point:()=>undefined,setOptions(){},
   dispose(){root.visible=false;}} as unknown as DynamicsReplay;
 };
 it('a load superseded by deactivate never makes the replay visible',async()=>{
  const session=createDynamicsSession(rig,new Group());
  const replay=fakeReplay();session.promise=Promise.resolve(replay);
  const src=DynamicsSource.create(session);
  const pending=src.load('x','baseline');
  src.deactivate();             // engine switched to another source mid-flight
  expect(await pending).toBe('superseded');
  expect(session.replay).toBeUndefined();      // never adopted into the scene
  expect(replay.root.visible).toBe(false);     // the stale await did not resurrect it
  expect(src.status).not.toBe('ready');
 });
 it('applies the replay when the load still owns the session',async()=>{
  const session=createDynamicsSession(rig,new Group());
  const replay=fakeReplay();session.promise=Promise.resolve(replay);
  const src=DynamicsSource.create(session);
  expect(await src.load('x','baseline')).toBe('applied');
  expect(session.replay).toBe(replay);
  expect(session.parent.children).toContain(replay.root);
  expect(replay.root.visible).toBe(true);
  expect(src.status).toBe('ready');
 });
 it('a newer load supersedes the one still in flight',async()=>{
  const session=createDynamicsSession(rig,new Group());
  session.promise=Promise.resolve(fakeReplay());
  const src=DynamicsSource.create(session);
  const first=src.load('a','baseline');
  const second=src.load('b','baseline');
  expect(await first).toBe('superseded');
  expect(await second).toBe('applied');
  expect(src.status).toBe('ready');
 });
 it('a disposed session reports superseded and disposes the unadopted replay',async()=>{
  const session=createDynamicsSession(rig,new Group());
  const replay=fakeReplay();let disposed=false;
  (replay as {dispose:()=>void}).dispose=()=>{disposed=true;};
  session.promise=Promise.resolve(replay);
  const src=DynamicsSource.create(session);
  const pending=src.load('x','baseline');
  src.dispose();
  expect(await pending).toBe('superseded');
  expect(disposed).toBe(true);
 });
 /* The two failure segments of load() are different contracts: a failed
  * replay CREATION poisons s.promise (must be released), but a failed RECORD
  * fetch happens after the replay was adopted into the session — dropping
  * s.promise then would make a retry build an unadoptable second replay
  * while session.replay/physics keep pointing at the record-less first one. */
 it('a failed record load keeps the adopted replay so the retry reuses it',async()=>{
  const session=createDynamicsSession(rig,new Group());
  const replay=fakeReplay();let loads=0;
  (replay as {load:DynamicsReplay['load']}).load=async()=>{
   loads++;if(loads===1)throw new Error('仿真记录未找到');return true;};
  const p=Promise.resolve(replay);session.promise=p;
  const src=DynamicsSource.create(session);
  expect(await src.load('missing','baseline')).toBe('error');
  expect(src.status).toBe('error');
  // The record segment failed, not the replay creation — both survive.
  expect(session.promise).toBe(p);
  expect(session.replay).toBe(replay);
  expect(await src.load('missing','baseline')).toBe('applied');
  expect(session.replay).toBe(replay);             // same object — no orphan second replay
  expect(session.parent.children).toEqual([replay.root]);
  expect(replay.root.visible).toBe(true);
  expect(loads).toBe(2);
 });
 it('a stale record-load failure must not clear the live session promise',async()=>{
  const session=createDynamicsSession(rig,new Group());
  const replay=fakeReplay();
  const pending:{res:(v:boolean)=>void;rej:(e:Error)=>void}[]=[];
  (replay as {load:DynamicsReplay['load']}).load=()=>new Promise<boolean>((res,rej)=>{pending.push({res,rej});});
  const p=Promise.resolve(replay);session.promise=p;
  const src=DynamicsSource.create(session);
  const stale=src.load('a','baseline');
  await Promise.resolve();await Promise.resolve(); // let stale reach the record-load await
  expect(pending.length).toBe(1);                  // parked inside replay.load
  const fresh=src.load('b','baseline');            // supersedes stale mid-record
  await Promise.resolve();await Promise.resolve();
  expect(pending.length).toBe(2);
  pending[0].rej(new Error('stale record failure')); // the stale record fetch dies late
  expect(await stale).toBe('superseded');
  pending[1].res(true);
  expect(await fresh).toBe('applied');
  // The stale catch ran and still left the current owner's session alone.
  expect(session.promise).toBe(p);
  expect(session.replay).toBe(replay);
  expect(replay.root.visible).toBe(true);
 });
});

/* The envelope-restore trust gate (engine.openPosePackage): the package's
 * action.definitionSHA256 must reproduce the local envelope's recomputed
 * definition hash before capabilities/name/phases may come from it. The
 * trust closure here is built on the same inputs the engine uses —
 * actionDefinitionHash(motionDefinitionPayload(file)) — so a tampered or
 * foreign-definition package degrades to the ad-hoc channel. rigMatches is
 * the pure rig-identity half of the same gate. */
describe('posePackageSpec — envelope trust + rig identity',()=>{
 const served=(id:string)=>handleRequest(ctx,'POST','/v1/motions',{action:{id}}).body as PosePackage;
 /** Same inputs the engine's closure uses: precomputed per-envelope
  * definition hashes, matched against the package's declared one. */
 const envelopeDef=(id:string)=>{
  const f=motionFileById(id);
  return f?.kind==='workshop-motion'?actionDefinitionHash(motionDefinitionPayload(f)):undefined;
 };
 const trustFor=(pkg:PosePackage)=>(actionId:string)=>
  envelopeDef(actionId)!==undefined&&envelopeDef(actionId)===pkg.action.definitionSHA256;
 it('a proven definitionSHA256 restores the envelope exactly as before',()=>{
  const pkg=served('forehand');
  const spec=posePackageSpec(pkg,'pkg:test',trustFor(pkg));
  expect(spec.capabilities?.prop).toEqual({kind:'racket',trail:true,handView:true});
  expect(spec.name).toBe(motionFileById('forehand')!.name);
  expect(spec.oneShot).toBe(true);
 });
 it('a tampered definitionSHA256 drops to the ad-hoc channel',()=>{
  const pkg=clone(served('forehand'));
  pkg.action.definitionSHA256='0'.repeat(64);
  const spec=posePackageSpec(pkg,'pkg:test',trustFor(pkg));
  // Bundled packages ship parameters:{} — nothing survives in the ad-hoc
  // channel, so capabilities are simply absent (or prop-hint only).
  expect(spec.capabilities).toBeUndefined();
  expect(spec.name).toBe('forehand');          // the claimed id, not the envelope display name
  expect(spec.method).toBe('服务交付轨迹 · FK 采样重放');
  // Carried a hash that failed the check → the 'mismatch' wording, not the
  // unverifiable one.
  expect(spec.description).toMatch(/definitionSHA256 与当前内置定义不符/);
  // The trajectory still plays — phases keep coming from the package's own events.
  expect(spec.phases).toEqual(motionFileById('forehand')!.phases);
 });
 it('a missing definitionSHA256 is equally untrusted',()=>{
  const pkg=clone(served('forehand'));
  (pkg.action as {definitionSHA256?:string}).definitionSHA256=undefined;
  const spec=posePackageSpec(pkg,'pkg:test',trustFor(pkg));
  expect(spec.capabilities).toBeUndefined();
  // Nothing was verifiable — the wording must say so, not claim a mismatch.
  expect(spec.description).toMatch(/definitionSHA256 缺失\/无法核验/);
 });
 it('a non-workshop-motion envelope hit is unverifiable, not a mismatch',()=>{
  const pkg=clone(served('forehand'));
  pkg.action.id='punch'; // dynamics-motion envelope — carries no definition hash at all
  const spec=posePackageSpec(pkg,'pkg:test',trustFor(pkg));
  expect(spec.capabilities).toBeUndefined();
  expect(spec.name).toBe('punch');
  expect(spec.description).toMatch(/definitionSHA256 缺失\/无法核验/);
 });
 it('rigMatches compares the declared manifest hash only when the local one is known',()=>{
  const pkg=served('idle');
  expect(rigMatches(pkg,manifest.manifestSHA256)).toBe(true);
  expect(rigMatches(pkg,'0'.repeat(64))).toBe(false);
  expect(rigMatches(pkg,undefined)).toBe(true); // unknowable → caller degrades, notes it
 });
});

describe('DocumentSource smoke',()=>{
 const load=(id:string)=>normalizeMotionFile(JSON.parse(fs.readFileSync(`assets/motions/${id}.json`,'utf8'))).document!;
 it('seeks a grip document to finite poses and reports the prop',()=>{
  for(const id of ['ready','forehand']){
   const src=new DocumentSource(rig,load(id));
   for(const t of [0,.5,1.7,src.duration]){
    src.seek(t);
    expect(src.point('foot_L')!.toArray().every(Number.isFinite)).toBe(true);
    expect(src.rootPoint().toArray().every(Number.isFinite)).toBe(true);
   }
   src.seek(Math.min(2,src.duration));
   expect(src.wantsProp()).toBe(true);
   expect(src.diagnostics()!.bones).toBe(163);
  }
 });
 it('keeps a non-grip document prop-free',()=>{
  const src=new DocumentSource(rig,load('idle'));
  src.seek(1);
  expect(src.wantsProp()).toBe(false);
  expect(src.diagnostics()).not.toBeNull();
 });
 it('exposes the authored grip side for mount steering',()=>{
  const doc=blankDocument(rig.rest,'左持拍','left-grip');
  doc.gripSide='L';doc.keys.forEach(k=>{k.constraints.grip=true;});
  const src=new DocumentSource(rig,doc,racket);
  expect(src.propSide).toBe('L');
  mountRacket(rig,racket,'L');
  src.seek(.5);
  expect(src.wantsProp()).toBe(true);
  expect(src.diagnostics()!.gripError).toBeLessThan(1e-6);
  mountRacket(rig,racket,'R');
 });
});

describe('ClipSource smoke',()=>{
 it('plays the baked walk clip through the shared mixer without throwing',()=>{
  const clip=AnimationClip.parse(JSON.parse(fs.readFileSync('public/models/walk.json','utf8')));
  const meta=JSON.parse(fs.readFileSync('public/models/walk-meta.json','utf8'));
  const mixer=new AnimationMixer(rig.model);
  const src=new ClipSource(rig,mixer,mixer.clipAction(clip),new Vector3().fromArray(meta.stride));
  src.setLoop(true);src.activate();
  for(const t of [0,.3,.7,src.duration-.01]){
   src.seek(t);
   expect(src.rootPoint().toArray().every(Number.isFinite)).toBe(true);
   expect(src.point('foot_L')!.toArray().every(Number.isFinite)).toBe(true);
  }
  // The stride side effect of a loop wrap accumulates into modelOffset.
  src.loopWrapAdvance();
  expect(src.modelOffset.distanceTo(new Vector3().fromArray(meta.stride))).toBeLessThan(1e-9);
  expect(src.wantsProp()).toBe(false);
  const d=src.diagnostics()!;
  expect(Number.isFinite(d.knee)).toBe(true);
  src.deactivate();
 });
});
