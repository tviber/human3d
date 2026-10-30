import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {Matrix4,Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from '@human3d/motion-core';
import {attachRacket,gripFrame,RACKET_HANDLE} from '@human3d/motion-core';
import {angleAt,DEG} from '@human3d/motion-core';
import {blankDocument,defaultDocument,ensureKey,flattenPose,frameAt,HEAD_ROTATION_LIMITS,mirrorDoc,parseDoc,retimeKeys,samplePose,serializeDoc,setKeyTime,sortedKeys,TANGENT_SECANT_CAP,toV,unflattenPose,validateDocShape,type PoseParams,type WorkshopDoc,type WorkshopKey} from '@human3d/motion-core';
import {DRAFT_PREFIX,LIBRARY_KEY,MotionLibrary,SAVED_MOTION_PREFIX,savedMotionSpec,WORKSHOP_PRESETS,type StorageLike} from './library';
import {DocHistory,HistoryBook,RecordGate} from './history';
import {WORKSHOP_LIMITS} from '@human3d/motion-core';
import {MOTION_FILES} from '@human3d/motion-core';
import {analyzePose,rotateHandFrame,solveEffectiveFrame,supportPolygon} from '@human3d/motion-core';
import {CaptureMutex,onionTimes,SHEET_MAX_TILES,sheetTimes} from './engine';

let rig:HumanRig,racket:ReturnType<typeof attachRacket>;
// frameAt's origin must be the rest root — the same value the engine and the
// service pass, so pelvis-frame hands resolve to the same world targets.
const origin=()=>rig.rest.get('root')!;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
 racket=attachRacket(rig);
},30000);

describe('workshop document',()=>{
 it('seeds a five-key forehand with constraints and a contact event',()=>{
  const doc=defaultDocument(rig.rest);
  expect(doc.keys.length).toBe(5);expect(doc.duration).toBe(.8);
  expect(doc.keys.every(k=>k.constraints.plantL&&k.constraints.plantR)).toBe(true);
  expect(doc.keys.filter(k=>k.constraints.contact).length).toBe(1);
 });
 it('flattens and restores poses bit-exactly',()=>{
  const doc=defaultDocument(rig.rest);
  for(const k of doc.keys)expect(unflattenPose(flattenPose(k.pose))).toEqual(k.pose);
 });
 it('round-trips through JSON',()=>{
  const doc=defaultDocument(rig.rest);doc.keys[0].interpolation='linear';
  const back=parseDoc(serializeDoc(doc));
  expect(back.keys.length).toBe(doc.keys.length);
  expect(back.keys[2].constraints.contact).toBe(true);
  expect(back.keys[2].pose.handR.target.x).toBeCloseTo(doc.keys[2].pose.handR.target.x,10);
  expect(back.keys[0].interpolation).toBe('linear');
 });
 it('samples, serializes, validates and mirrors the optional head turns',()=>{
  const doc=blankDocument(rig.rest,'头部朝向','head-turn');
  doc.keys[0].pose.headYaw=-24;doc.keys[0].pose.headPitch=10;
  doc.keys[1].pose.headYaw=32;doc.keys[1].pose.headPitch=-14;
  doc.keys[0].interpolation='linear';
  expect(samplePose(doc,.5).headYaw).toBeCloseTo(4,8);
  expect(samplePose(doc,.5).headPitch).toBeCloseTo(-2,8);
  const restored=parseDoc(serializeDoc(doc));
  expect(restored.keys[0].pose.headYaw).toBe(-24);
  expect(restored.keys[1].pose.headPitch).toBe(-14);
  const mirrored=mirrorDoc(doc);
  expect(mirrored.keys[0].pose.headYaw).toBe(24);
  expect(mirrored.keys[0].pose.headPitch).toBe(10);
  expect(mirrorDoc(mirrored)).toEqual(doc);
  const invalid=structuredClone(doc);invalid.keys[0].pose.headYaw=HEAD_ROTATION_LIMITS.yaw[1]+1;
  expect(validateDocShape(invalid).some(e=>e.includes('headYaw'))).toBe(true);
 });
 it('selects linear or smooth Hermite interpolation per outgoing key',()=>{
  const doc=blankDocument(rig.rest,'曲线选择','curve-choice');
  doc.keys[0].pose.root.x=0;doc.keys[1].pose.root.x=1;
  expect(samplePose(doc,.25).root.x).toBeCloseTo(.15625,8); // bounded Hermite with zero endpoint tangents
  doc.keys[0].interpolation='linear';
  expect(samplePose(doc,.25).root.x).toBeCloseTo(.25,8);
  expect(samplePose(doc,.75).root.x).toBeCloseTo(.75,8);
  const raw=JSON.parse(serializeDoc(doc)) as {keys:{interpolation?:string}[]};
  raw.keys[0].interpolation='ease';
  expect(validateDocShape(raw).some(e=>e.includes('interpolation'))).toBe(true);
 });
 it('reproduces key poses at their exact times and stays finite between',()=>{
  const doc=defaultDocument(rig.rest),keys=sortedKeys(doc);
  for(const k of keys){
   const p=samplePose(doc,k.time);
   for(const [a,b]of [[flattenPose(p),flattenPose(k.pose)]]as const)for(let i=0;i<a.length;i++)expect(a[i]).toBeCloseTo(b[i],6);
  }
  for(let i=0;i<=200;i++){const p=samplePose(doc,i/200*doc.duration);expect(flattenPose(p).every(Number.isFinite)).toBe(true);}
 });
 it('holds planted-foot targets constant over each interval',()=>{
  const doc=defaultDocument(rig.rest),keys=sortedKeys(doc);
  for(let i=0;i<keys.length-1;i++){
   const k=keys[i];if(!k.constraints.plantL)continue;
   for(let s=0;s<=10;s++){
    const p=samplePose(doc,k.time+(keys[i+1].time-k.time)*s/10);
    expect(toV(p.footL.target).distanceTo(toV(k.pose.footL.target))).toBeLessThan(1e-9);
   }
  }
 });
 it('takes the short angular path when yaw wraps through ±180°',()=>{
  const doc=blankDocument(rig.rest,'转身','yaw-wrap');
  doc.keys[0].pose.yaw=179;doc.keys[1].pose.yaw=-179;
  const mid=samplePose(doc,.5);
  // 2° short path: midpoint ≈ ±180°, never crosses 0.
  expect(Math.abs(mid.yaw)).toBeGreaterThan(179.5);expect(Math.abs(mid.yaw)).toBeLessThan(181);
 });
 it('interpolates hand direction frames as rotations, never through the zero vector',()=>{
  const doc=blankDocument(rig.rest,'转手','frame-slerp');
  doc.keys[0].pose.handR.forward={x:1,y:0,z:0};doc.keys[0].pose.handR.normal={x:0,y:1,z:0};
  doc.keys[1].pose.handR.forward={x:-1,y:0,z:0};doc.keys[1].pose.handR.normal={x:0,y:1,z:0};
  for(let i=0;i<=10;i++){
   const p=samplePose(doc,i/10),f=toV(p.handR.forward),n=toV(p.handR.normal);
   expect(f.length()).toBeGreaterThan(.99);expect(n.length()).toBeGreaterThan(.99);
   expect(Math.abs(f.dot(n))).toBeLessThan(1e-6);
  }
 });
 it('holds a continuous foot contact across planted keys and lifts off from the contact point',()=>{
  const doc=blankDocument(rig.rest,'换脚','contact-run');
  const A={x:.2,y:0,z:.3},B={x:.5,y:.12,z:.1},C={x:-.1,y:0,z:.4};
  doc.keys[0].pose.footL.target={...A};doc.keys[1].pose.footL.target={...B};
  // Second planted key mid-run: contact still holds A even though the key stores B.
  const mid=samplePose(doc,.5),atKey=samplePose(doc,1);
  expect(toV(mid.footL.target).distanceTo(toV(A))).toBeLessThan(1e-9);
  expect(toV(atKey.footL.target).distanceTo(toV(A))).toBeLessThan(1e-9);
  // Release key between two contacts: the stored (already-lifted) B is
  // ignored — the foot lifts FROM A and swings to the replant target C.
  const lifted={...doc.keys[1],constraints:{...doc.keys[1].constraints,plantL:false}};
  const replanted={id:'k3',time:2,label:'',pose:{...doc.keys[1].pose,footL:{...doc.keys[1].pose.footL,target:{...C}}},constraints:{...doc.keys[1].constraints}};
  doc.duration=2;doc.keys=[doc.keys[0],lifted,replanted];
  const at=(t:number)=>toV(samplePose(doc,t).footL.target);
  expect(at(1).distanceTo(toV(A))).toBeLessThan(1e-9);
  expect(at(2).distanceTo(toV(C))).toBeLessThan(1e-9);
  expect(at(1.5).distanceTo(toV(A))).toBeGreaterThan(.05);
  expect(at(1.5).distanceTo(toV(C))).toBeGreaterThan(.05);
 });
 it('uses a linear outgoing curve through the release key’s swing waypoint',()=>{
  const doc=blankDocument(rig.rest,'线性摆动','linear-release'),A={x:.2,y:0,z:.3},B={x:.5,y:.12,z:.1},C={x:-.1,y:0,z:.4};
  doc.duration=2;doc.keys[1].time=1;doc.keys[1].constraints.plantL=false;
  doc.keys[1].pose.footL.target={...B};doc.keys[1].interpolation='linear';
  doc.keys[0].pose.footL.target={...A};
  doc.keys.push({id:'k3',time:2,label:'',pose:{...doc.keys[1].pose,footL:{...doc.keys[1].pose.footL,target:{...C}}},constraints:{...doc.keys[1].constraints,plantL:true}});
  const at=(t:number)=>toV(samplePose(doc,t).footL.target);
  expect(at(1).distanceTo(toV(A))).toBeLessThan(1e-9);
  expect(at(1.25).distanceTo(toV(A).lerp(toV(B),.5))).toBeLessThan(1e-9);
  expect(at(1.5).distanceTo(toV(B))).toBeLessThan(1e-9);
  expect(at(1.75).distanceTo(toV(B).lerp(toV(C),.5))).toBeLessThan(1e-9);
  expect(at(2).distanceTo(toV(C))).toBeLessThan(1e-9);
 });
 it('keeps foot position AND velocity continuous across support transitions',()=>{
  const doc=blankDocument(rig.rest,'换脚','boundary-continuity');
  const A={x:.2,y:0,z:.3},C={x:-.1,y:0,z:.4};
  doc.duration=2;
  doc.keys[0].pose.footL.target={...A};
  doc.keys[1].constraints.plantL=false;doc.keys[1].pose.footL.target={x:.5,y:.12,z:.1}; // released mid-doc, stores a lifted pose
  doc.keys.push({id:'k3',time:2,label:'',pose:{...doc.keys[1].pose,footL:{...doc.keys[1].pose.footL,target:{...C}}},constraints:{...doc.keys[1].constraints,plantL:true}});
  doc.keys.sort((a,b)=>a.time-b.time);
  const at=(t:number)=>toV(samplePose(doc,t).footL.target);
  // Position: approaching the lift key from the left keeps A; at and after
  // the key the foot departs from A — never teleports to the stored pose.
  for(const t of [.95,.999,1,1.001])expect(at(t).distanceTo(toV(A))).toBeLessThan(.01);
  // Velocity: both transitions move through rest — finite differences shrink
  // to ~0 at the lift (t=1) and the replant (t=2).
  const eps=1e-3,v=(t:number)=>at(t+eps).sub(at(t-eps)).length()/(2*eps);
  expect(v(1)).toBeLessThan(.05);
  expect(v(2)).toBeLessThan(.05);
  // Mid-swing the foot is genuinely in flight — and genuinely OFF THE
  // GROUND: the release key's stored pose is a waypoint the path passes
  // through at the interval midpoint, not a smoothstep slide.
  expect(v(1.5)).toBeGreaterThan(.1);
  expect(at(1.5).y).toBeCloseTo(.12,9);
  expect(at(1.5).y).toBeGreaterThan(Math.max(A.y,C.y)+.05);
  for(let s=0;s<=20;s++)expect(at(1+s/40).y).toBeGreaterThanOrEqual(-1e-9);
 });
 it('retimes duration proportionally instead of collapsing keys onto one time',()=>{
  const doc=defaultDocument(rig.rest);retimeKeys(doc,.4);
  const times=sortedKeys(doc).map(k=>k.time);
  times.forEach((t,i)=>expect(t).toBeCloseTo([0,.11,.25,.33,.4][i],6));
  for(let i=1;i<times.length;i++)expect(times[i]).toBeGreaterThan(times[i-1]);
  for(let i=0;i<=50;i++)expect(flattenPose(samplePose(doc,i/50*.4)).every(Number.isFinite)).toBe(true);
 });
 it('keeps loop keys strictly increasing when shrinking duration into the seam',()=>{
  // Repro from review: 0, .98, .99 at 1.0s retimed to 0.2s — clamping only the
  // last key into the seam gap used to drop it below its predecessor.
  const doc=blankDocument(rig.rest,'循环','loop-retime');
  doc.keys[1].time=.98;
  const tail=JSON.parse(JSON.stringify(doc.keys[1])) as WorkshopKey;tail.id='k-tail';tail.time=.99;
  doc.keys.push(tail);doc.loop=true;
  retimeKeys(doc,.2);
  const times=sortedKeys(doc).map(k=>k.time);
  expect(times[0]).toBe(0);
  for(let i=1;i<times.length;i++)expect(times[i]).toBeGreaterThan(times[i-1]);
  expect(Math.max(...times)).toBeLessThanOrEqual(doc.duration-WORKSHOP_LIMITS.loopGap+1e-9);
  expect(validateDocShape(doc)).toEqual([]);
 });
 it('keeps loop keys ordered when duration grows too',()=>{
  const doc=blankDocument(rig.rest,'循环','loop-grow');
  doc.keys[1].time=.98;doc.duration=1;doc.loop=true;
  retimeKeys(doc,5);
  const times=sortedKeys(doc).map(k=>k.time);
  expect(times[0]).toBe(0);expect(times[1]).toBeCloseTo(.98*(5-WORKSHOP_LIMITS.loopGap)/.99,9);
  expect(validateDocShape(doc)).toEqual([]);
 });
 it('keeps single-key retiming strictly inside neighbour bounds',()=>{
  const doc=defaultDocument(rig.rest),keys=sortedKeys(doc);
  setKeyTime(doc,keys[2],99);
  expect(keys[2].time).toBeCloseTo(keys[3].time-.01,9);
  setKeyTime(doc,keys[2],-99);
  expect(keys[2].time).toBeCloseTo(keys[1].time+.01,9);
 });
 it('rejects malformed docs on every checked dimension',()=>{
  const good=JSON.parse(serializeDoc(blankDocument(rig.rest,'好','ok')));
  expect(validateDocShape(good)).toEqual([]);
  const cases:[string,(d:Record<string,unknown>)=>void][]=[
   ['重复时间',d=>{(d.keys as {time:number}[])[1].time=(d.keys as {time:number}[])[0].time;}],
   ['NaN 目标',d=>{((d.keys as {pose:{handL:{target:{x:number}}}}[])[0].pose.handL.target.x)=NaN;}],
   ['零向量朝向',d=>{((d.keys as {pose:{handL:{forward:{x:number;y:number;z:number}}}}[])[0].pose.handL.forward)={x:0,y:0,z:0};}],
   ['非布尔约束',d=>{((d.keys as {constraints:{plantL:unknown}}[])[0].constraints.plantL)='yes';}],
   ['越界时间',d=>{(d.keys as {time:number}[])[1].time=99;}],
  ];
  for(const [,mutate]of cases){const d=JSON.parse(JSON.stringify(good));mutate(d);expect(validateDocShape(d).length).toBeGreaterThan(0);}
  for(const [,mutate]of cases){const d=JSON.parse(JSON.stringify(good));mutate(d);expect(()=>parseDoc(JSON.stringify(d))).toThrow();}
 });
 it('auto-keys by sampling the live pose at insert time',()=>{
  const doc=defaultDocument(rig.rest),origin=rig.rest.get('root')!;
  const expected=frameAt(doc,.35,origin).pose;
  const k=ensureKey(doc,.35,origin)!;
  expect(doc.keys.length).toBe(6);expect(k.time).toBe(.35);
  for(let i=0;i<flattenPose(expected).length;i++)expect(flattenPose(k.pose)[i]).toBeCloseTo(flattenPose(expected)[i],6);
  expect(ensureKey(doc,.35,origin)!.id).toBe(k.id);
 });
 it('carries the interval curve onto both segments when inserting a key',()=>{
  const doc=blankDocument(rig.rest,'线性拆分','linear-split');
  doc.keys[0].interpolation='linear';
  const inserted=ensureKey(doc,.5,origin())!;
  expect(inserted.interpolation).toBe('linear');
  expect(samplePose(doc,.25).root.x).toBeCloseTo(doc.keys[0].pose.root.x+(inserted.pose.root.x-doc.keys[0].pose.root.x)*.5,8);
 });
 it('auto-keyed poses land on the live pose — insertion must not shift the hands',()=>{
  // handFrames=pelvis + trunk rotation: sampling the insert pose with a
  // different origin stores a shifted copy of the world hand targets. The
  // workbench passes its rest root, so the frame at the new key is identical
  // to the frame it replaced.
  const doc=defaultDocument(rig.rest),origin=rig.rest.get('root')!,t=.35;
  const before=flattenPose(frameAt(doc,t,origin).pose);
  ensureKey(doc,t,origin);
  const after=flattenPose(frameAt(doc,t,origin).pose);
  for(let i=0;i<before.length;i++)expect(after[i]).toBeCloseTo(before[i],9);
 });
 it('refuses a new key at the maxKeys limit instead of saving an invalid doc',()=>{
  const doc=blankDocument(rig.rest,'满','full');
  doc.duration=WORKSHOP_LIMITS.maxDuration;
  doc.keys.forEach((k,i)=>{k.time=i*doc.duration/WORKSHOP_LIMITS.maxKeys;});
  while(doc.keys.length<WORKSHOP_LIMITS.maxKeys){const k=JSON.parse(JSON.stringify(doc.keys[1])) as WorkshopKey;k.id=`kf${doc.keys.length}`;k.time=doc.keys.length*doc.duration/WORKSHOP_LIMITS.maxKeys;doc.keys.push(k);}
  expect(validateDocShape(doc)).toEqual([]);
  // A time between existing keys cannot take a new key; the doc stays valid.
  expect(ensureKey(doc,.045)).toBeUndefined();
  expect(doc.keys.length).toBe(WORKSHOP_LIMITS.maxKeys);
  expect(validateDocShape(doc)).toEqual([]);
  // Reusing an existing key still works at the limit.
  expect(ensureKey(doc,doc.keys[3].time)!.id).toBe(doc.keys[3].id);
 });
});
describe('Catmull-Rom tangent clamp (WP-C)',()=>{
 /* Sparse keys let the nonuniform centre difference scale the slow side of
  * an asymmetric neighbourhood, whipping the spline past the keyed range —
  * defaultDocument wrist_R peaked ≈22 rad/s before the fix vs ≈6 for the
  * bundled forehand. tan() now caps |m| at TANGENT_SECANT_CAP=2 × the
  * smaller adjacent secant, sign-symmetric, shared by the loop ghost chain.
  * The cases below pin the observable contract through the real sample
  * path: excursion bound, bitwise key reproduction, C¹, seam-smooth loop.
  * footR.target.y is a plain world channel and all keys are unplanted, so
  * no contact override or release-swing path touches the channel. */
 const sparse=(times:number[],ys:number[],duration:number,loop=false)=>{
  const doc=blankDocument(rig.rest,'clamp','clamp');
  const template=JSON.parse(JSON.stringify(doc.keys[0])) as WorkshopKey;
  doc.keys=times.map((time,i)=>{
   const k=JSON.parse(JSON.stringify(template)) as WorkshopKey;
   k.id=`c${i}`;k.time=time;k.constraints={plantL:false,plantR:false,grip:false,contact:false};
   k.pose.footR.target.y=ys[i];return k;
  });
  doc.duration=duration;doc.loop=loop;
  return doc;
 };
 it('bounds sparse-key overshoot while leaving the keyed values bitwise intact',()=>{
  // y = .1 → .5 → .45 over t = 0/.05/1: secants +8 and −.0526 m/s while the
  // raw centre difference at the middle key is +.35 m/s — 6.7× the weak
  // side. κ=2 caps it at .105; measured peak excursion past the .5 ceiling
  // drops ~5× (0.0079m vs 0.0390m for the uncapped Hermite reference).
  const doc=sparse([0,.05,1],[.1,.5,.45],1);
  const at=(t:number)=>samplePose(doc,t,origin()).footR.target.y;
  for(const k of sortedKeys(doc))expect(at(k.time)).toBe(k.pose.footR.target.y);
  let peak=0;for(let s=0;s<=20000;s++)peak=Math.max(peak,at(s/20000));
  // Analytic cap: excursion ≤ κ·|weak secant|·Δt·max h10(u) = cap·.95·4/27.
  const cap=TANGENT_SECANT_CAP*Math.abs((.45-.5)/.95);
  expect(peak-.5).toBeLessThanOrEqual(cap*.95*(4/27)+1e-9);
  // The PRE-fix curve: same keys, raw centre-difference tangents, evaluated
  // on the same Hermite basis — this pins that the clamp truly reduces the
  // overshoot, not just stays under a theoretical bound.
  const h=(u:number,v0:number,m0:number,v1:number,m1:number,dt:number)=>
   (2*u**3-3*u*u+1)*v0+(u**3-2*u*u+u)*dt*m0+(-2*u**3+3*u*u)*v1+(u**3-u*u)*dt*m1;
  const rawTan=(.45-.1)/(1-0); // uncapped centre difference at the middle key
  let raw=0;for(let s=0;s<=20000;s++){const u=s/20000;
   raw=Math.max(raw,h(u,.1,0,.5,rawTan,.05),h(u,.5,rawTan,.45,0,.95));}
  expect(peak-.5).toBeLessThan((raw-.5)*.6); // excursions: .0079 vs .0390
 });
 it('keeps C¹ velocity through a key whose tangent the clamp reduced',()=>{
  // keys 0/.5/1 with y = 0/.4/.45: secants .8 and .1 m/s, raw centre
  // difference .45 m/s → capped to .2. One clamped tangent serves both
  // adjoining cubics, so one-sided velocities converge to it from either
  // side (measured: 0.200040 / 0.199998 at ε=1e-5).
  const doc=sparse([0,.5,1],[0,.4,.45],1);
  const at=(t:number)=>samplePose(doc,t,origin()).footR.target.y,e=1e-4;
  const vL=(at(.5)-at(.5-e))/e,vR=(at(.5+e)-at(.5))/e;
  expect(vL).toBeCloseTo(.2,2);expect(vR).toBeCloseTo(.2,2);
  expect(Math.abs(vL-vR)).toBeLessThan(.005); // |Δ| ≈ 4.2e-4
 });
 it('stays velocity-continuous across the loop seam when the clamp binds on wrapped tangents',()=>{
  // loop t=1.5, keys 0/.5/1.2 with y = 0/.4/.05. Across the ghost chain the
  // wrap tangent at key 0 sees secants |0−.05|/.3 = .167 and |.4−0|/.5 = .8
  // → raw .4375 capped to .333; the same value closes interval [1.2,1.5]
  // and opens [0,.5], so the foot keeps rising smoothly through the wrap.
  const doc=sparse([0,.5,1.2],[0,.4,.05],1.5,true);
  const at=(t:number)=>samplePose(doc,t,origin()).footR.target.y,e=1e-4;
  expect(at(doc.duration)).toBe(at(0)); // seam value, bitwise
  const vIn=(at(doc.duration)-at(doc.duration-e))/e,vOut=(at(e)-at(0))/e;
  expect(Math.abs(vIn-vOut)).toBeLessThan(.01); // measured |Δ| ≈ 6e-4, both ≈ .333
 });
});
describe('workshop solver',()=>{
 it('keeps bone lengths and joint limits across the whole motion',()=>{
  const doc=defaultDocument(rig.rest);
  for(let i=0;i<=40;i++){
   const f=frameAt(doc,i/40*doc.duration,origin());solveEffectiveFrame(rig,f);
   for(const [n,b]of rig.bones){if(n!=='root')expect(b.position.distanceTo(rig.restLocal.get(n)!)).toBeLessThan(1e-7);expect(b.quaternion.length()).toBeCloseTo(1,4);}
   for(const side of ['L','R']as const){
    expect(angleAt(rig.point(`upperleg01_${side}`),rig.point(`lowerleg01_${side}`),rig.point(`foot_${side}`))).toBeLessThanOrEqual(135.1);
    expect(angleAt(rig.point(`upperarm01_${side}`),rig.point(`lowerarm01_${side}`),rig.point(`wrist_${side}`))).toBeLessThanOrEqual(145.1);
   }
  }
 });
 it('keeps planted feet at their targets within IK residual',()=>{
  const doc=defaultDocument(rig.rest);
  for(let i=0;i<=40;i++){
   const f=frameAt(doc,i/40*doc.duration,origin());solveEffectiveFrame(rig,f);
   for(const side of ['L','R']as const){
    const planted=side==='L'?f.constraints.plantL:f.constraints.plantR;if(!planted)continue;
    const t=toV((side==='L'?f.pose.footL:f.pose.footR).target);
    expect(rig.point(`foot_${side}`).distanceTo(t)).toBeLessThan(.005);
   }
  }
 });
 it('keeps the grip transform fixed while grip is constrained',()=>{
  const doc=defaultDocument(rig.rest);
  for(let i=0;i<=40;i++){
   const f=frameAt(doc,i/40*doc.duration,origin());solveEffectiveFrame(rig,f);
   const expected=rig.bone('wrist_R').localToWorld(gripFrame(rig,'R',RACKET_HANDLE).center.clone());
   expect(racket.getWorldPosition(new Vector3()).distanceTo(expected)).toBeLessThan(1e-10);
  }
 });
 it('reports a stable balance check on the ready key',()=>{
  const doc=defaultDocument(rig.rest),f=frameAt(doc,0,origin());
  solveEffectiveFrame(rig,f);
  const a=analyzePose(rig,f.pose,f.constraints,racket);
  expect(a.comStable).toBe(true);expect(a.support.length).toBeGreaterThanOrEqual(3);
  expect(a.items.every(i=>i.ok)).toBe(true);
 });
 it('flags balance when the root is dragged far off the feet',()=>{
  const doc=defaultDocument(rig.rest),k=ensureKey(doc,0)!;
  k.pose.root.z=.6;
  const f=frameAt(doc,0,origin());solveEffectiveFrame(rig,f);
  const a=analyzePose(rig,f.pose,f.constraints,racket);
  expect(a.comStable).toBe(false);
 });
});
describe('hand orientation editing',()=>{
 it('keeps the forward/normal pair orthonormal under slider deltas',()=>{
  const doc=defaultDocument(rig.rest),h=doc.keys[2].pose.handR;
  for(const [kind,d]of [['flex',23],['dev',-31],['twist',47]]as const)rotateHandFrame(h,kind,d);
  const f=toV(h.forward),n=toV(h.normal);
  expect(f.length()).toBeCloseTo(1,8);expect(n.length()).toBeCloseTo(1,8);
  expect(Math.abs(f.dot(n))).toBeLessThan(1e-8);
 });
 it('builds a support polygon only from planted feet',()=>{
  const doc=defaultDocument(rig.rest),k=doc.keys[0];
  const both=supportPolygon(k.pose,k.constraints);
  expect(both.length).toBeGreaterThanOrEqual(6);
  const none=supportPolygon(k.pose,{...k.constraints,plantL:false,plantR:false});
  expect(none.length).toBe(0);
 });
});
describe('undo and redo',()=>{
 it('restores exact snapshots, clears redo on a new edit and respects the limit',()=>{
  const h=new DocHistory(3),doc=blankDocument(rig.rest,'u','u');
  const s0=serializeDoc(doc);
  h.record(doc);doc.keys[0].pose.lean=10;
  h.record(doc);doc.keys[0].pose.lean=20;
  expect(h.canUndo()).toBe(true);expect(h.canRedo()).toBe(false);
  const back=h.undo(doc)!;expect(back.keys[0].pose.lean).toBe(10);
  const again=h.redo(back)!;expect(again.keys[0].pose.lean).toBe(20);
  const back2=h.undo(again)!;const back3=h.undo(back2)!;
  expect(serializeDoc(back3)).toBe(s0);
  expect(h.undo(back3)).toBeUndefined();
  // A new edit after an undo discards the redo branch.
  h.record(back3);expect(h.canRedo()).toBe(false);
  // Identical snapshots collapse, and the limit drops the oldest entries.
  for(let i=0;i<10;i++){h.record(doc);doc.keys[0].pose.lean=30+i;}
  let n=0;let cur=doc;while(h.canUndo()){cur=h.undo(cur)!;n++;}
  expect(n).toBe(3);
 });
 it('keeps a separate history per motion', ()=>{
  const book=new HistoryBook(),a=blankDocument(rig.rest,'a','a'),b=blankDocument(rig.rest,'b','b');
  book.of('a').record(a);expect(book.of('b').canUndo()).toBe(false);
 });
 it('merges rapid edits only inside one document and one transaction',()=>{
  const g=new RecordGate(600);
  expect(g.should('a',1000)).toBe(true);
  expect(g.should('a',1200)).toBe(false); // same doc, inside the window → one step
  expect(g.should('b',1300)).toBe(true);  // a different doc always gets a snapshot
  expect(g.should('b',1400)).toBe(false);
  expect(g.should('a',1500)).toBe(true);  // switching back is a new transaction
  g.reset();
  expect(g.should('a',1600)).toBe(true);  // after undo/redo the next edit records
  expect(g.should('a',1700)).toBe(false);
  expect(g.should('a',2400)).toBe(true);  // window elapsed
 });
});
describe('motion library',()=>{
 const memStorage=():StorageLike&{map:Map<string,string>}=>{const map=new Map<string,string>();return {map,get length(){return map.size;},key:i=>[...map.keys()][i]??null,removeItem:k=>{map.delete(k);},getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v);}}};
 const lib=(s?:StorageLike)=>new MotionLibrary(rig.rest,s).load();
 it('seeds with the example forehand on first run',()=>{
  const l=lib(memStorage());
  expect(l.docs.length).toBe(1);expect(l.active().id).toBe('forehand-workshop');
 });
 it('checkpoints before waiting for the lock, recovers a closed page into quarantine, and cleans only committed drafts',async()=>{
  const store=memStorage();lib(store);
  const writes:(()=>void)[]=[],lock=(_key:string,write:()=>void)=>new Promise<void>(resolve=>writes.push(()=>{write();resolve();}));
  const a=new MotionLibrary(rig.rest,store,lock).load();
  a.active().keys[0].label='等待锁期间的修改';const pending=a.save();
  expect(a.saveState).toBe('saving');expect(writes).toHaveLength(1);
  const draft=[...store.map.keys()].find(k=>k.startsWith(DRAFT_PREFIX))!;
  expect(JSON.parse(store.map.get(draft)!).docs[0].keys[0].label).toBe('等待锁期间的修改');
  expect(new MotionLibrary(rig.rest,store).load({readOnly:true}).quarantine).toEqual([]);
  const recovered=new MotionLibrary(rig.rest,store,lock).load();
  expect(recovered.quarantine).toEqual([]);expect(store.map.has(draft)).toBe(true);
  // Commit the recovering page; the original page is treated as terminated.
  writes[1]();await recovered.saved;
  const index=recovered.quarantine.findIndex(q=>q.reason.includes('草稿'));
  expect(JSON.parse(recovered.quarantineText(index)).keys[0].label).toBe('等待锁期间的修改');
  expect(store.map.has(draft)).toBe(false);
  const restored=lib(store);expect(restored.quarantine.some(q=>q.reason.includes('草稿'))).toBe(true);
  const copy=parseDoc(restored.quarantineText(0));restored.add(copy);
  expect(lib(store).active().keys[0].label).toBe('等待锁期间的修改');
  // A still-live original page may complete later without erasing recovery.
  writes[0]();await pending;expect(a.saveState).toBe('saved');
  expect(lib(store).quarantine.length).toBeGreaterThan(0);
  expect([...store.map.keys()].filter(k=>k.startsWith(DRAFT_PREFIX))).toEqual([]);
 });
 it('rechecks recovery under the lock after the active editor has saved',async()=>{
  const store=memStorage();lib(store);
  const writes:(()=>void)[]=[],lock=(_key:string,write:()=>void)=>new Promise<void>(resolve=>writes.push(()=>{write();resolve();}));
  const a=new MotionLibrary(rig.rest,store,lock).load();a.rename(a.activeId,'尚在编辑');
  const b=new MotionLibrary(rig.rest,store,lock).load();expect(b.quarantine).toEqual([]);
  a.rename(a.activeId,'继续编辑后的最终版本');
  writes[0]();writes[1]();writes[2]();await Promise.all([a.saved,b.saved]);
  expect(b.quarantine).toEqual([]);const restored=lib(store);expect(restored.active().name).toBe('继续编辑后的最终版本');expect(restored.quarantine).toEqual([]);
  expect([...store.map.keys()].filter(k=>k.startsWith(DRAFT_PREFIX))).toEqual([]);
 });
 it('skips an active owner even when its checkpoint has no queued save, then recovers after closure',async()=>{
  const store=memStorage();lib(store);let active=true;
  const writer={id:'writer',ready:Promise.resolve(),active:async(id:string)=>id==='writer'&&active};
  const a=new MotionLibrary(rig.rest,store,async(_key,write)=>{await write();},writer).load();
  a.active().name='仅有同步草稿';a.checkpoint();const key=[...store.map.keys()].find(k=>k.startsWith(DRAFT_PREFIX))!;
  const reader={...writer,id:'reader'};
  const b=new MotionLibrary(rig.rest,store,async(_key,write)=>{await write();},reader).load();await b.saved;
  expect(b.quarantine).toEqual([]);expect(store.map.has(key)).toBe(true);
  active=false;const recovered=new MotionLibrary(rig.rest,store,async(_key,write)=>{await write();},reader).load();await recovered.saved;
  expect(recovered.quarantine[0].name).toBe('仅有同步草稿');expect(store.map.has(key)).toBe(false);
 });
 it('cleans an orphan snapshot already committed to the main library without duplicating it',()=>{
  const store=memStorage();lib(store);const file=JSON.parse(store.map.get(LIBRARY_KEY)!);
  store.map.set(DRAFT_PREFIX+'committed',JSON.stringify(file));
  expect(lib(store).quarantine).toEqual([]);expect(store.map.has(DRAFT_PREFIX+'committed')).toBe(false);
 });
 it('retains the recovery source if the locked main-library write fails',()=>{
  const store=memStorage();lib(store);const file=JSON.parse(store.map.get(LIBRARY_KEY)!);file.docs[0].name='尚未提交的恢复稿';
  const key=DRAFT_PREFIX+'failed';store.map.set(key,JSON.stringify(file));const original=store.setItem;
  store.setItem=(key,text)=>{if(key===LIBRARY_KEY)throw new Error('quota');original(key,text);};
  const recovered=lib(store);expect(recovered.lastError).toBe('quota');expect(recovered.quarantine[0].name).toBe('尚未提交的恢复稿');expect(store.map.has(key)).toBe(true);
  store.setItem=original;const restored=lib(store);expect(restored.quarantine[0].name).toBe('尚未提交的恢复稿');expect(store.map.has(key)).toBe(false);
 });
 it('keeps the committed baseline and cleans only the captured draft when editing continues during commit',async()=>{
  const store=memStorage();lib(store);const commits:(()=>void)[]=[];
  const lock=async(key:string,write:(snapshot?:StorageLike)=>void|Promise<void>)=>{
   let value=store.getItem(key);await write({getItem:()=>value,setItem:(_key,text)=>{value=text;}});
   await new Promise<void>(resolve=>commits.push(()=>{store.setItem(key,value!);resolve();}));
  };
  const a=new MotionLibrary(rig.rest,store,lock).load();a.active().name='提交中 A1';const first=a.save();await Promise.resolve();
  a.active().name='继续编辑 A2';a.checkpoint();const newer=[...store.map.keys()].find(k=>k.startsWith(DRAFT_PREFIX))!;
  expect(a.saveState).toBe('saving');commits[0]();await first;
  expect(store.map.has(newer)).toBe(true);expect(a.saveState).toBe('saving');
  const b=new MotionLibrary(rig.rest,store).load({readOnly:true});b.rename(b.activeId,'远端 B');a.sync();
  expect(a.active().name).toBe('继续编辑 A2');expect(a.quarantine.some(q=>q.name==='远端 B')).toBe(true);
  const second=a.save();await Promise.resolve();commits[1]();await second;
  expect(a.saveState).toBe('saved');expect(new MotionLibrary(rig.rest,store).load({readOnly:true}).active().name).toBe('继续编辑 A2');
  expect([...store.map.keys()].filter(k=>k.startsWith(DRAFT_PREFIX))).toEqual([]);
 });
 it('does not publish a new baseline or remove its draft when the storage transaction rejects',async()=>{
  const store=memStorage();lib(store);const before=store.map.get(LIBRARY_KEY);
  const a=new MotionLibrary(rig.rest,store,async(_key,write)=>{let value:string|null=null;await write({getItem:key=>store.getItem(key),setItem:(_key,text)=>{value=text;}});expect(value).toContain('事务失败的修改');throw new Error('transaction aborted');}).load();
  a.active().name='事务失败的修改';await a.save();expect(a.saveState).toBe('error');expect(store.map.get(LIBRARY_KEY)).toBe(before);
  a.sync();expect(a.active().name).toBe('事务失败的修改');expect([...store.map.keys()].some(k=>k.startsWith(DRAFT_PREFIX))).toBe(true);
 });
 it('hydrates an authoritative snapshot without reading a stale mirror, preserving generated quarantine on sync',()=>{
  const store=memStorage(),a=lib(store),snapshot=store.map.get(LIBRARY_KEY)!;
  store.map.set(LIBRARY_KEY,'{broken mirror');const damaged=lib(store);damaged.sync(new MotionLibrary(rig.rest,store).load({readOnly:true,snapshotText:snapshot}));
  expect(damaged.quarantine.some(q=>q.raw==='{broken mirror')).toBe(true);
  store.getItem=()=>{throw new Error('unavailable mirror');};
  expect(new MotionLibrary(rig.rest,store).load({readOnly:true,snapshotText:snapshot}).active().id).toBe(a.activeId);
  expect(new MotionLibrary(rig.rest,store).load({readOnly:true,snapshotText:null}).docs).toEqual([]);
 });
 it('replaces a draft only after the next immutable checkpoint is durable',()=>{
  const store=memStorage();lib(store);
  const a=new MotionLibrary(rig.rest,store,()=>new Promise<void>(()=>{})).load();
  a.active().name='第一份草稿';a.save();const first=[...store.map.keys()].find(k=>k.startsWith(DRAFT_PREFIX))!,text=store.map.get(first);
  a.active().name='第二份草稿';a.checkpoint();const second=[...store.map.keys()].find(k=>k.startsWith(DRAFT_PREFIX))!;
  expect(second).not.toBe(first);expect(store.map.has(first)).toBe(false);
  expect(JSON.parse(store.map.get(second)!).docs[0].name).toBe('第二份草稿');
  store.setItem=()=>{throw new Error('quota');};a.active().name='未写入的第三份';a.checkpoint();
  expect(a.saveState).toBe('error');expect(a.lastError).toBe('quota');expect(store.map.has(second)).toBe(true);expect(text).toContain('第一份草稿');
 });
 it('does not recover an older edit after it was reverted before the lock was granted',()=>{
  const store=memStorage();lib(store);const a=new MotionLibrary(rig.rest,store,()=>new Promise<void>(()=>{})).load(),before=a.active().name;
  a.rename(a.activeId,'撤销前');expect([...store.map.keys()].some(k=>k.startsWith(DRAFT_PREFIX))).toBe(true);
  a.rename(a.activeId,before);expect([...store.map.keys()].filter(k=>k.startsWith(DRAFT_PREFIX))).toEqual([]);
  expect(lib(store).quarantine).toEqual([]);
 });
 it('retains drafts on lock failure and reports all queued saves until completion',async()=>{
  const store=memStorage();lib(store);
  const a=new MotionLibrary(rig.rest,store,async()=>{throw new Error('no Web Locks');}).load();
  a.active().name='不支持锁仍可恢复';await a.save();expect(a.saveState).toBe('error');
  expect(lib(store).quarantine.some(q=>q.name==='不支持锁仍可恢复')).toBe(true);
  const writes:(()=>void)[]=[],b=new MotionLibrary(rig.rest,store,(_key,write)=>new Promise<void>(resolve=>writes.push(()=>{write();resolve();}))).load();
  b.rename(b.activeId,'连续编辑1');b.rename(b.activeId,'连续编辑2');
  writes[0]();expect(b.saveState).toBe('saving');writes[1]();await b.saved;expect(b.saveState).toBe('saved');
  expect(lib(store).active().name).toBe('连续编辑2');
 });
 it('preserves an unreadable draft verbatim and never claims unavailable storage was saved',()=>{
  const store=memStorage();lib(store);store.map.set(DRAFT_PREFIX+'broken','{broken');
  const restored=lib(store);expect(restored.quarantineText(0)).toBe('{broken');expect(store.map.has(DRAFT_PREFIX+'broken')).toBe(false);
  expect(lib(store).quarantineText(0)).toBe('{broken');
  const unavailable=new MotionLibrary(rig.rest,null).load();expect(unavailable.saveState).toBe('error');expect(unavailable.lastError).toContain('存储不可用');
 });
 it('merges stale independent edits and preserves additions without resurrecting deletions',()=>{
  const store=memStorage(),a=lib(store),second=a.create('第二段');
  const b=lib(store),first=a.docs[0].id;
  a.docs.find(d=>d.id===first)!.keys[0].label='A 修改';a.save();
  b.docs.find(d=>d.id===second.id)!.keys[0].label='B 修改';b.save();
  let restored=new MotionLibrary(rig.rest,store).load({readOnly:true});
  expect(restored.docs.find(d=>d.id===first)!.keys[0].label).toBe('A 修改');
  expect(restored.docs.find(d=>d.id===second.id)!.keys[0].label).toBe('B 修改');
  a.remove(first);b.rename(second.id,'继续编辑');
  restored=new MotionLibrary(rig.rest,store).load({readOnly:true});
  expect(restored.docs.some(d=>d.id===first)).toBe(false);
  expect(restored.docs.find(d=>d.id===second.id)!.name).toBe('继续编辑');
 });
 it('adopts remote reorder and keeps it through later unrelated saves',()=>{
  const store=memStorage(),a=lib(store),first=a.activeId,second=a.create('第二段').id,b=lib(store);
  a.reorder(second,first);b.sync();expect(b.docs.map(d=>d.id)).toEqual([second,first]);
  b.rename(first,'改名');expect(new MotionLibrary(rig.rest,store).load({readOnly:true}).docs.map(d=>d.id)).toEqual([second,first]);
  const c=lib(store),third=a.create('第三段').id;
  c.docs.reverse();c.sync();expect(c.docs.map(d=>d.id)).toEqual([first,second,third]);
 });
 it('sync keeps dirty edits and exports both sides of a same-document conflict',()=>{
  const store=memStorage(),a=lib(store),b=lib(store),id=a.activeId;
  a.active().keys[0].label='A 修改';b.active().keys[0].label='B 修改';
  a.save();b.sync();
  expect(b.active().keys[0].label).toBe('B 修改');
  expect(JSON.parse(b.quarantineText(0)).keys[0].label).toBe('A 修改');
  b.save();const restored=new MotionLibrary(rig.rest,store).load({readOnly:true});
  expect(restored.docs.find(d=>d.id===id)!.keys[0].label).toBe('B 修改');
  expect(JSON.parse(restored.quarantineText(0)).keys[0].label).toBe('A 修改');
 });
 it('preserves an edited document in quarantine when a concurrent page deletes it',()=>{
  const store=memStorage(),a=lib(store),b=lib(store),id=a.activeId;
  b.active().keys[0].label='未保存的修改';a.remove(id,false);b.save();
  const restored=new MotionLibrary(rig.rest,store).load({readOnly:true});
  expect(restored.docs).toEqual([]);
  expect(JSON.parse(restored.quarantineText(0)).keys[0].label).toBe('未保存的修改');
 });
 it('does not overwrite newly corrupted storage on save',()=>{
  const store=memStorage(),a=lib(store);a.active().keys[0].label='仍在内存';
  store.map.set(LIBRARY_KEY,'{broken');a.save();
  expect(store.map.get(LIBRARY_KEY)).toBe('{broken');expect(a.lastError).toMatch(/无法读取/);
  expect(a.active().keys[0].label).toBe('仍在内存');
 });
 it('reads saved documents without writing, seeding or replacing quarantined data',()=>{
  const store=memStorage();
  expect(new MotionLibrary(rig.rest,store).load({readOnly:true}).docs).toEqual([]);expect(store.map.size).toBe(0);
  const l=lib(store),doc=l.create('我的动作');doc.keys[0].pose.lean=13;l.save();const raw=store.map.get(LIBRARY_KEY);
  const read=new MotionLibrary(rig.rest,store).load({readOnly:true});expect(read.docs.find(d=>d.id===doc.id)?.keys[0].pose.lean).toBe(13);expect(store.map.get(LIBRARY_KEY)).toBe(raw);
  store.map.set(LIBRARY_KEY,'{broken');const quarantined=new MotionLibrary(rig.rest,store).load({readOnly:true});expect(quarantined.docs).toEqual([]);expect(quarantined.quarantine[0].raw).toBe('{broken');expect(store.map.get(LIBRARY_KEY)).toBe('{broken');
 });
 it('can delete the last saved motion without adding a replacement to the lab library',()=>{
  const store=memStorage(),l=lib(store),old=l.active().id;l.remove(old,false);
  expect(new MotionLibrary(rig.rest,store).load({readOnly:true}).docs).toEqual([]);
  const workshop=new MotionLibrary(rig.rest,store).load();expect(workshop.docs).toHaveLength(1);expect(workshop.active().id).not.toBe(old);expect(workshop.active().keys).toHaveLength(2);
 });
 it('derives playback metadata and identity from the saved document without changing its keys',()=>{
  const l=lib(memStorage()),doc=l.create('左手动作');doc.id='forehand';doc.gripSide='L';doc.keys[0].constraints.grip=true;
  const before=serializeDoc(doc),spec=savedMotionSpec(doc);
  expect(spec.id).toBe(SAVED_MOTION_PREFIX+'forehand');expect(spec.id).not.toBe('forehand');expect(spec.name).toBe(doc.name);expect(spec.oneShot).toBe(!doc.loop);
  expect(spec.source).toEqual({kind:'document',document:doc});expect(spec.capabilities?.prop?.side).toBe('L');expect(spec.phases).toEqual(sortedKeys(doc).map(k=>({time:k.time,label:k.label||'关键帧'})));
  expect(serializeDoc(doc)).toBe(before);
 });
 it('reorders documents and persists the new order',()=>{
  const store=memStorage(), l=lib(store);
  const a=l.create('A'), b=l.create('B');
  l.reorder(b.id, a.id);
  expect(l.docs.map(d=>d.id)).toEqual(['forehand-workshop', b.id, a.id]);
  const back=new MotionLibrary(rig.rest, store).load();
  expect(back.docs.map(d=>d.id)).toEqual(['forehand-workshop', b.id, a.id]);
  l.reorder('missing', a.id);
  expect(l.docs.map(d=>d.id)).toEqual(['forehand-workshop', b.id, a.id]);
 });
 it('creates named blank motions with unique ids and a valid stance',()=>{
  const l=lib(memStorage());
  const a=l.create('发球'),b=l.create('发球');
  expect(a.id).not.toBe(b.id);expect(l.active().id).toBe(b.id);expect(l.docs.length).toBe(3);
  for(const doc of [a,b]){expect(doc.keys.length).toBe(2);expect(doc.keys.every(k=>k.constraints.plantL&&k.constraints.plantR&&!k.constraints.grip)).toBe(true);}
  const f=frameAt(a,0,origin());solveEffectiveFrame(rig,f);
  expect(analyzePose(rig,f.pose,f.constraints).comStable).toBe(true);
 });
 it('duplicates deep-copies keys so editing a copy leaves the source intact',()=>{
  const l=lib(memStorage()),src=l.active();
  const copy=l.duplicate(src.id)!;
  expect(copy.name).toBe(`${src.name} 副本`);expect(copy.keys.length).toBe(src.keys.length);
  copy.keys[0].pose.lean=44;copy.keys[0].constraints.grip=false;
  expect(src.keys[0].pose.lean).not.toBe(44);
 });
 it('creates independent editable copies of every bundled trajectory and preserves solved poses',()=>{
  const store=memStorage(),l=lib(store),previous=serializeDoc(l.active());
  expect(WORKSHOP_PRESETS.map(p=>p.id)).toEqual(MOTION_FILES.filter(p=>p.kind==='workshop-motion').map(p=>p.id));
  expect(WORKSHOP_PRESETS.some(p=>p.id==='forehand')).toBe(true);
  for(const preset of WORKSHOP_PRESETS){
   const original=JSON.stringify(preset),source=preset.document!;
   const copy=l.createFromPreset(preset.id),again=l.createFromPreset(preset.id,'  我的动作  ');
   expect(copy.id).not.toBe(source.id);expect(again.id).not.toBe(copy.id);
   expect(copy.name).toBe(`${preset.name} 副本`);expect(again.name).toBe('我的动作');
   expect(l.active().id).toBe(again.id);
   expect({...copy,id:source.id,name:source.name,keys:copy.keys.map((k,i)=>({...k,id:source.keys[i].id}))}).toEqual(source);
   expect(copy.keys.every(k=>!source.keys.some(s=>s.id===k.id)&&!again.keys.some(a=>a.id===k.id))).toBe(true);
   for(const time of [0,source.duration/2,source.duration]){
    solveEffectiveFrame(rig,frameAt(source,time,origin()));
    const expected=[...rig.bones.keys()].map(n=>rig.point(n).clone());
    solveEffectiveFrame(rig,frameAt(copy,time,origin()));
    [...rig.bones.keys()].forEach((n,i)=>expect(rig.point(n).distanceTo(expected[i])).toBeLessThan(1e-10));
   }
   copy.keys[0].pose.handR.target.x+=.05;copy.keys[0].constraints.grip=!copy.keys[0].constraints.grip;
   expect(JSON.stringify(preset)).toBe(original);
   expect(again.keys[0].pose).toEqual(source.keys[0].pose);
  }
  l.save();const restored=new MotionLibrary(rig.rest,store).load();
  expect(restored.quarantine).toEqual([]);expect(restored.docs.length).toBe(l.docs.length);
  restored.docs.forEach((doc,i)=>{
   const saved=l.docs[i];
   expect({...doc,keys:[]}).toEqual({...saved,keys:[]});
   doc.keys.forEach((k,j)=>{
    expect({...k,pose:undefined}).toEqual({...saved.keys[j],pose:undefined});
    const expected=flattenPose(saved.keys[j].pose);
    flattenPose(k.pose).forEach((v,n)=>expect(v).toBeCloseTo(expected[n],12));
   });
  });
  expect(restored.activeId).toBe(l.activeId);expect(serializeDoc(l.docs[0])).toBe(previous);
 });
 it('rejects unsupported or unknown presets without changing the library or storage',()=>{
  const store=memStorage(),l=lib(store),before=store.map.get(LIBRARY_KEY);
  for(const id of [...MOTION_FILES.filter(p=>p.kind!=='workshop-motion').map(p=>p.id),'missing']){
   expect(()=>l.createFromPreset(id)).toThrow('没有可编辑的工作台轨迹');
   expect(store.map.get(LIBRARY_KEY)).toBe(before);expect(l.docs.length).toBe(1);
  }
 });
 it('selects, removes and always keeps at least one motion',()=>{
  const l=lib(memStorage());
  const a=l.create('A'),b=l.create('B');
  l.select(a.id);expect(l.active().id).toBe(a.id);
  l.remove(a.id);expect(l.active().id).toBe(b.id);
  l.remove(b.id);l.remove('forehand-workshop');
  expect(l.docs.length).toBe(1);expect(l.docs[0].keys.length).toBe(2);
 });
 it('drops the deleted doc\'s undo book so a same-id re-import cannot revive stale snapshots',()=>{
  // The WorkshopApp wiring: removal drops the document's history book. A doc
  // re-imported with the same id must start with an empty undo stack — an
  // undeleted book would let undo restore the deleted doc's content onto the
  // new document, a zombie write no edit ever produced.
  const l=lib(memStorage()),books=new HistoryBook();
  l.onRemoved=id=>books.drop(id);
  const src=l.active();
  books.of(src.id).record(src);
  expect(books.of(src.id).canUndo()).toBe(true);
  l.remove(src.id);
  // Re-import the same serialized document: no id clash now, so it keeps the id.
  const added=l.add(parseDoc(serializeDoc(src)));
  expect(added.id).toBe(src.id);
  expect(books.of(added.id).canUndo()).toBe(false);
  expect(books.of(added.id).undo(added)).toBeUndefined();
 });
 it('persists and restores the whole library through storage',()=>{
  const store=memStorage(),l=lib(store);
  const made=l.create('正手截击');made.keys[0].label='引拍';made.name='改名后的截击';l.save();
  const back=new MotionLibrary(rig.rest,store).load();
  expect(back.docs.length).toBe(2);expect(back.active().id).toBe(made.id);
  expect(back.active().name).toBe('改名后的截击');expect(back.active().keys[0].label).toBe('引拍');
 });
 it('reseeds cleanly from corrupted storage and skips invalid docs',()=>{
  const store=memStorage();store.map.set(LIBRARY_KEY,'{corrupted');
  expect(lib(store).docs.length).toBe(1);
  store.map.set(LIBRARY_KEY,JSON.stringify({schemaVersion:1,activeId:'x',docs:[{bogus:true},defaultDocument(rig.rest)]}));
  const l=lib(store);expect(l.docs.length).toBe(1);expect(l.active().id).toBe('forehand-workshop');
 });
 it('regenerates clashing ids on import',()=>{
  const l=lib(memStorage()),doc=parseDoc(serializeDoc(l.active()));
  const added=l.add(doc);
  expect(added.id).not.toBe('forehand-workshop');expect(l.docs.length).toBe(2);expect(l.active().id).toBe(added.id);
 });
 it('surfaces storage failures instead of claiming the motion was saved',()=>{
  const failing:StorageLike={getItem:()=>null,setItem:()=>{throw new Error('quota');}};
  const l=lib(failing);
  expect(l.lastError).toBe('quota');
  l.create('X');expect(l.lastError).toBe('quota');
 });
 it('round-trips boundary documents through save and reload without quarantine',()=>{
  const store=memStorage(),l=lib(store);
  // A document at the key limit…
  const full=l.create('满'),tmpl=JSON.parse(JSON.stringify(full.keys[0])) as WorkshopKey;
  full.duration=WORKSHOP_LIMITS.maxDuration;
  full.keys.forEach((k,i)=>{k.time=i*full.duration/WORKSHOP_LIMITS.maxKeys;});
  while(full.keys.length<WORKSHOP_LIMITS.maxKeys){const k=JSON.parse(JSON.stringify(tmpl)) as WorkshopKey;k.id=`kf${full.keys.length}`;k.time=full.keys.length*full.duration/WORKSHOP_LIMITS.maxKeys;full.keys.push(k);}
  // …and a loop document retimed down to the shortest duration.
  const looped=l.create('循环');
  looped.keys[1].time=.98;looped.duration=1;looped.loop=true;
  retimeKeys(looped,.2);
  for(const d of [full,looped])expect(validateDocShape(d)).toEqual([]);
  l.save();
  const back=new MotionLibrary(rig.rest,store).load();
  expect(back.quarantine.length).toBe(0);
  expect(back.docs.find(d=>d.id===full.id)?.keys.length).toBe(WORKSHOP_LIMITS.maxKeys);
  expect(back.docs.find(d=>d.id===looped.id)?.loop).toBe(true);
 });
 it('keeps an unreadable library file in quarantine instead of overwriting it',()=>{
  const store=memStorage();
  // Unparseable JSON: preserved verbatim, storage untouched.
  store.map.set(LIBRARY_KEY,'{"schemaVersion":2,"docs":[{broken');
  const l=lib(store);
  expect(l.docs.length).toBe(1); // a usable seed document in memory
  expect(l.quarantine.length).toBe(1);
  expect(l.quarantine[0].raw).toBe('{"schemaVersion":2,"docs":[{broken');
  expect(store.map.get(LIBRARY_KEY)).toBe('{"schemaVersion":2,"docs":[{broken');
  // Parseable but unknown schemaVersion (e.g. a future format): same rule.
  store.map.set(LIBRARY_KEY,JSON.stringify({schemaVersion:9,docs:[]}));
  const l2=new MotionLibrary(rig.rest,store).load();
  expect(l2.quarantine.length).toBe(1);
  expect(JSON.parse(store.map.get(LIBRARY_KEY)!).schemaVersion).toBe(9);
 });
 it('quarantines deeply-invalid stored docs with a reason instead of dropping them',()=>{
  const store=memStorage(),doc=JSON.parse(serializeDoc(defaultDocument(rig.rest)));
  doc.keys[1].time=doc.keys[0].time; // duplicate times now fail validation
  store.map.set(LIBRARY_KEY,JSON.stringify({schemaVersion:2,activeId:doc.id,docs:[doc,defaultDocument(rig.rest)]}));
  const l=new MotionLibrary(rig.rest,store).load();
  expect(l.docs.length).toBe(1);expect(l.docs[0].id).toBe('forehand-workshop');
  expect(l.quarantine.length).toBe(1);expect(l.quarantine[0].id).toBe(doc.id);
  expect(l.quarantine[0].reason.length).toBeGreaterThan(0);
  expect(JSON.parse(l.quarantineText(0)).keys[1].time).toBe(doc.keys[0].time);
  // The quarantine survives a save/load cycle and is written as schema v2.
  const back=new MotionLibrary(rig.rest,store).load();
  expect(back.quarantine.length).toBe(1);
  expect(JSON.parse(store.map.get(LIBRARY_KEY)!).schemaVersion).toBe(2);
  back.discardQuarantine(0);expect(back.quarantine.length).toBe(0);
 });
 it('refuses v1 documents with a readable reason instead of migrating them',()=>{
  const store=memStorage(),doc=JSON.parse(serializeDoc(defaultDocument(rig.rest)));
  delete doc.loop;delete doc.handFrames;doc.schemaVersion=1;
  store.map.set(LIBRARY_KEY,JSON.stringify({schemaVersion:2,activeId:doc.id,docs:[doc]}));
  const l=new MotionLibrary(rig.rest,store).load();
  // The v1 doc cannot enter the library: it lands in quarantine carrying the
  // validator's own message, and the empty library re-seeds from the example.
  expect(l.quarantine.length).toBe(1);
  expect(l.quarantine[0].reason).toContain('schemaVersion 必须为 2');
  expect(l.docs.length).toBe(1);expect(l.docs[0].schemaVersion).toBe(2);
 });
 it('keeps an unreadable library container (v1 or corrupt) quarantined without overwriting it',()=>{
  const store=memStorage(),doc=JSON.parse(serializeDoc(defaultDocument(rig.rest)));
  const raw=JSON.stringify({schemaVersion:1,activeId:doc.id,docs:[doc]});
  store.map.set(LIBRARY_KEY,raw);
  const l=new MotionLibrary(rig.rest,store).load();
  expect(l.quarantine.length).toBe(1);expect(l.quarantine[0].id).toBe('library-file');
  // The original bytes survive verbatim and are NOT auto-rewritten.
  expect(l.quarantineText(0)).toBe(raw);
  expect(store.map.get(LIBRARY_KEY)).toBe(raw);
 });
});

describe('document.interpolate hand frame cubic (WP-C squad)',()=>{
 // Rebuild the frame quaternion from a sampled pose the same way
 // interpolate() emits it (orthonormal basis u=f×n), so every check below
 // measures the real output product through the shared sampling path.
 const frameQ=(p:PoseParams,side:'L'|'R')=>{
  const h=side==='L'?p.handL:p.handR,f=toV(h.forward).normalize(),
    n=toV(h.normal).addScaledVector(f,-toV(h.normal).dot(f)).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(f,n,new Vector3().crossVectors(f,n)));
 };
 const relLn=(a:Quaternion,b:Quaternion)=>{
  const d=a.clone().invert().multiply(b);
  if(d.w<0)d.set(-d.x,-d.y,-d.z,-d.w);
  const s=Math.hypot(d.x,d.y,d.z);
  return s<1e-15?new Vector3():new Vector3(d.x,d.y,d.z).multiplyScalar(Math.atan2(s,d.w)/s);
 };
 // One-sided hand-frame angular velocities bracketing t, finite-differenced
 // on the sampled path — no access to private internals. Convention: the
 // quatLn half-angle rate (vec(q⁻¹q̇)=ω/2, so |ω|=2× these magnitudes) —
 // left/right share it, so every continuity comparison below is unaffected.
 const omegaAround=(doc:WorkshopDoc,t:number,e:number,side:'L'|'R')=>{
  const q=frameQ(samplePose(doc,t,origin()),side);
  return {left:relLn(frameQ(samplePose(doc,t-e,origin()),side),q).multiplyScalar(1/e),
    right:relLn(q,frameQ(samplePose(doc,t+e,origin()),side)).multiplyScalar(1/e)};
 };
 const setFrame=(k:WorkshopKey,f:[number,number,number],n:[number,number,number])=>{
  k.pose.handR.forward={x:f[0],y:f[1],z:f[2]};k.pose.handR.normal={x:n[0],y:n[1],z:n[2]};
 };

 it('reproduces stored hand frames at every key instant',()=>{
  const doc=defaultDocument(rig.rest);let err=0;
  for(const k of doc.keys){
   const p=samplePose(doc,k.time,origin());
   for(const s of ['L','R']as const){
    const h=s==='L'?k.pose.handL:k.pose.handR,ph=s==='L'?p.handL:p.handR;
    err=Math.max(err,toV(h.forward).distanceTo(toV(ph.forward)),toV(h.normal).distanceTo(toV(ph.normal)));
   }
  }
  expect(err).toBeLessThan(1e-9); // measured ≤7.3e-16 — exact key pass-through
 });
 it('keeps hand-frame angular velocity continuous through keys (finite difference)',()=>{
  // e=1e-4s 校准:defaultDocument(骨盆系,非均匀键距)实测最大 |ωL−ωR|=0.017
  // (quatLn 半角率口径,见 omegaAround 注释);旧逐段 slerp 同一探针测得 ~10
  // (键时刻 C0 跳变)。阈值取 3×实测、远低于缺陷量级——测的是轨迹形态,
  // 不是实现细节(learning[1])。
  const doc=defaultDocument(rig.rest),e=1e-4;
  for(const s of ['L','R']as const)
   for(const k of doc.keys.slice(1,-1)){
    const{left,right}=omegaAround(doc,k.time,e,s);
    expect(left.distanceTo(right)).toBeLessThan(.05);
   }
 });
 it('holds the same C¹ on a sparse world-frame document',()=>{
  const doc=blankDocument(rig.rest,'world-c1','world-c1');
  doc.handFrames={L:'world',R:'world'};
  ensureKey(doc,.4,origin());
  rotateHandFrame(doc.keys[1].pose.handR,'flex',90);
  rotateHandFrame(doc.keys[2].pose.handR,'twist',120);
  const{left,right}=omegaAround(doc,.4,1e-4,'R');
  expect(left.distanceTo(right)).toBeLessThan(.05);
 });
 it('keeps adjacent same-pose keys still — no special-casing needed',()=>{
  // k0 and k1 share the same hand frame, k2 turns: the secant cap reads a
  // zero adjacent secant at k1, so the still interval gets zero tangents on
  // both ends naturally. Asserting the trajectory shape, not the code path.
  const doc=blankDocument(rig.rest,'still','still');
  doc.handFrames={L:'world',R:'world'};
  ensureKey(doc,.5,origin());
  rotateHandFrame(doc.keys[2].pose.handR,'flex',60);
  const q0=frameQ(samplePose(doc,0,origin()),'R');
  for(const t of [.125,.25,.375,.5])
   expect(frameQ(samplePose(doc,t,origin()),'R').angleTo(q0)).toBeLessThan(1e-9); // measured exactly 0
  const{left,right}=omegaAround(doc,.5,1e-4,'R');
  expect(left.length()).toBeLessThan(1e-9);
  expect(right.length()).toBeLessThan(1e-3); // T at k1 is exactly 0; finite-diff residual only
 });
 it('holds value and angular-velocity continuity across the loop seam',()=>{
  const doc=blankDocument(rig.rest,'loop-seam','loop-seam');
  doc.handFrames={L:'world',R:'world'};
  doc.loop=true;doc.duration=1.2;doc.keys[1].time=.6;
  rotateHandFrame(doc.keys[1].pose.handR,'flex',70);
  const e=1e-4,q0=frameQ(samplePose(doc,0,origin()),'R'),qD=frameQ(samplePose(doc,doc.duration,origin()),'R');
  expect(qD.angleTo(q0)).toBeLessThan(1e-9); // wrap value is the same rotation
  const wl=relLn(frameQ(samplePose(doc,doc.duration-e,origin()),'R'),qD).multiplyScalar(1/e);
  const wr=relLn(q0,frameQ(samplePose(doc,e,origin()),'R')).multiplyScalar(1/e);
  expect(wl.distanceTo(wr)).toBeLessThan(.05); // measured 0.001 (half-angle rate, as relLn)
 });
 it('interpolates hand frames in pelvis coordinates when handFrames=pelvis',()=>{
  // Both keys store the SAME pelvis-relative frame (world f/n = yaw_j·const):
  // any in-between must read yaw(t)·const — i.e. the cubic ran on the pelvis
  // conversion, before the yaw(t) re-rotation, not on the world values.
  const doc=blankDocument(rig.rest,'pelvis','pelvis');
  doc.keys[0].pose.yaw=0;doc.keys[1].pose.yaw=60;
  const yq=(deg:number)=>new Quaternion().setFromAxisAngle(new Vector3(0,1,0),deg*DEG);
  const cf=new Vector3(1,0,0),cn=new Vector3(0,1,0);
  for(const k of doc.keys){
   const r=yq(k.pose.yaw),f=cf.clone().applyQuaternion(r),n=cn.clone().applyQuaternion(r);
   k.pose.handR.forward={x:f.x,y:f.y,z:f.z};k.pose.handR.normal={x:n.x,y:n.y,z:n.z};
  }
  const qc=new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(cf,cn,new Vector3().crossVectors(cf,cn)));
  for(const t of [.2,.5,.8]){
   const p=samplePose(doc,t,origin());
   expect(frameQ(p,'R').angleTo(yq(p.yaw).multiply(qc))).toBeLessThan(1e-9);
  }
 });
 it('unwraps the frame chain to one hemisphere so antipodal reps take the short arc',()=>{
  // This key1 frame is a 155° rotation from key0's, but setFromRotationMatrix
  // emits its quat in the opposite hemisphere (dot<0). Without the chain-wide
  // unwrap the tangent logs would steer the segment down the ~205° arc.
  const doc=blankDocument(rig.rest,'hemi','hemi');
  doc.handFrames={L:'world',R:'world'};doc.duration=1;
  setFrame(doc.keys[0],[1,0,0],[0,1,0]);
  setFrame(doc.keys[1],[-0.8503,0.5215,0.0706],[-0.0671,0.0256,-0.9974]);
  const q0=frameQ(samplePose(doc,0,origin()),'R'),q1=frameQ(samplePose(doc,1,origin()),'R');
  let maxA=0,maxW=0,prev=q0;
  for(let i=1;i<=400;i++){
   const q=frameQ(samplePose(doc,i/400,origin()),'R');
   maxA=Math.max(maxA,q.angleTo(q0));maxW=Math.max(maxW,q.angleTo(prev)*400);prev=q;
  }
  expect(q1.angleTo(q0)).toBeCloseTo(2.704,2);    // the 155° key lands exactly
  expect(maxA).toBeLessThan(3.1);                  // stays on the 155° arc, never near ~205°
  expect(maxW).toBeLessThan(12);                   // no residual branch jump
 });
});

describe('onion skin ghost instants',()=>{
 // defaultDocument keys sit at 0 / .22 / .5 / .66 / .8 s. (built lazily —
 // rig is only populated by beforeAll).
 const doc=()=>defaultDocument(rig.rest);
 const o={onionCount:2,onionMode:'keys' as const,onionStep:.1};
 it('brackets the playhead with the ±N nearest real keys in keys mode',()=>{
  // Parked ON the contact key: that key is the live pose — ghosts are the two
  // keys before and after it, nearest first (dist 1).
  expect(onionTimes(doc(),.5,o).map(g=>[g.dir,g.dist,g.time])).toEqual([[-1,2,0],[-1,1,.22],[1,1,.66],[1,2,.8]]);
  expect(onionTimes(doc(),.6,{...o,onionCount:1}).map(g=>[g.dir,g.dist,g.time])).toEqual([[-1,1,.5],[1,1,.66]]);
 });
 it('caps ghosts at ONION_MAX per side — a dense document is never fully ghosted',()=>{
  const dense=doc();for(let i=1;i<=9;i++)dense.keys.push({...dense.keys[0],id:`kx${i}`,time:i/10*dense.duration});
  const t=onionTimes(dense,.5,{...o,onionCount:99});
  expect(t.length).toBe(6); // 8 keys bracket each side; only the nearest 3 ghost
  expect(t.filter(g=>g.dir===-1).map(g=>g.dist)).toEqual([3,2,1]);
  expect(t.filter(g=>g.dir===1).map(g=>g.dist)).toEqual([1,2,3]);
 });
 it('step mode takes t±k·Δt and drops instants outside the document',()=>{
  expect(onionTimes(doc(),.5,{onionCount:2,onionMode:'step',onionStep:.1}).map(g=>[g.dir,g.dist,+g.time.toFixed(6)]))
   .toEqual([[-1,1,.4],[1,1,.6],[-1,2,.3],[1,2,.7]]);
  // Near t=0 no past instants exist; only the future side is drawn.
  const t=onionTimes(doc(),.05,{onionCount:3,onionMode:'step',onionStep:.1});
  expect(t.every(g=>g.dir===1)).toBe(true);
  expect(t.map(g=>+g.time.toFixed(6))).toEqual([.15,.25,.35]);
 });
 it('wraps the keys bracket across the seam on a loop document',()=>{
  // Keys at 0/.3/.6/.9 in a 1.2 s loop. Parked at .05 the real past holds only
  // k@0 — the next-nearest previous ghosts are the previous cycle's tail keys
  // at their own instants (the sampler wraps the same way), so k@0 keeps
  // dist 1 and k@.9 follows behind it, never duplicated onto the after side.
  const d=blankDocument(rig.rest,'loop','loop');d.loop=true;d.duration=1.2;d.keys[1].time=.9;
  for(const [id,t]of [['k-a',.3],['k-b',.6]]as const){const k:WorkshopKey=JSON.parse(JSON.stringify(d.keys[0]));k.id=id;k.time=t;d.keys.push(k);}
  const ts=onionTimes(d,.05,{onionCount:2,onionMode:'keys',onionStep:.1}).map(g=>[g.dir,g.dist,g.time]);
  expect(ts).toEqual([[-1,2,.9],[-1,1,0],[1,1,.3],[1,2,.6]]);
  // The key under the playhead stays the live pose even across the wrap.
  const on=onionTimes(d,.6,{onionCount:2,onionMode:'keys',onionStep:.1});
  expect(on.every(g=>g.time!==.6)).toBe(true);
 });
});

describe('contact-sheet time sampling (WP-D)',()=>{
 it('keeps every key time when the count fits the tile budget',()=>{
  expect(sheetTimes([0,.22,.5,.66,.8])).toEqual([0,.22,.5,.66,.8]);
  expect(sheetTimes([])).toEqual([]);
 });
 it('decimates uniformly to the cap, pinning both endpoints',()=>{
  const ts=Array.from({length:30},(_,i)=>i*.1);
  const out=sheetTimes(ts);
  expect(out.length).toBe(SHEET_MAX_TILES);
  expect(out[0]).toBe(0);
  expect(out.at(-1)).toBe(ts.at(-1)); // last key time always survives decimation (bit-exact, not re-derived)
  expect(new Set(out).size).toBe(SHEET_MAX_TILES); // step>1 ⇒ strictly increasing, no dup tiles
 });
 it('honours a smaller cap and preserves caller order',()=>{
  expect(sheetTimes([2,0,1],2)).toEqual([2,1]);
  expect(sheetTimes([0,.5,1],99)).toEqual([0,.5,1]);
 });
});

describe('capture export mutex (WP-D review)',()=>{
 /* The engine can't be instantiated without WebGL, so the re-entrancy gate
  * lives in an exported class — this is the real object captureStill /
  * captureSheet delegate to. A second capture must reject outright (two
  * interleaved captures would restore each other's state snapshots), and
  * the flag must reset even when the capture itself throws. */
 it('rejects a concurrent capture while one is in flight',async()=>{
  const m=new CaptureMutex();
  let release!:(v:string)=>void;
  const pending=new Promise<string>(res=>{release=res;});
  const first=m.run(()=>pending);
  expect(m.held).toBe(true);
  await expect(m.run(async()=>'nested')).rejects.toThrow('已有导出任务进行中');
  release('done');
  await expect(first).resolves.toBe('done');
  expect(m.held).toBe(false);
 });
 it('resets the gate when the capture rejects, so the next export can run',async()=>{
  const m=new CaptureMutex();
  await expect(m.run(async()=>{throw new Error('encode boom');})).rejects.toThrow('encode boom');
  expect(m.held).toBe(false);
  await expect(m.run(async()=>'ok')).resolves.toBe('ok');
 });
});
