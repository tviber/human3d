import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {blankDocument,flattenPose,frameAt,HumanRig,mirrorDoc,serializeDoc,solveEffectiveFrame,validateDocShape,WORKSHOP_LIMITS} from '@human3d/motion-core';
import type {WorkshopDoc} from '@human3d/motion-core';
import {combineMotions} from './combine-motions';
import {MotionLibrary} from './library';
let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);
const origin=()=>rig.rest.get('root')!;
const doc=(name:string,duration=1)=>{const d=blankDocument(rig.rest,name,name);d.duration=duration;d.keys[1].time=duration;return d;};
const closePose=(a:number[],b:number[])=>a.forEach((v,i)=>expect(v,`channel ${i}`).toBeCloseTo(b[i],7));
const fk=(d:WorkshopDoc,t:number)=>{solveEffectiveFrame(rig,frameAt(d,t,origin()));return [...rig.bones.keys()].flatMap(n=>rig.point(n).toArray());};

describe('combine saved motions through the production document sampler',()=>{
 it('appends with a transition, retains source knots and saves a separate playable document',()=>{
  const a=doc('a'),b=doc('b',1.4);a.keys.forEach(k=>k.pose.lean=10);b.keys.forEach(k=>k.pose.lean=30);
  const sources=[serializeDoc(a),serializeDoc(b)];
  const out=combineMotions(a,b,{kind:'append',transition:.4},origin(),'串联');
  expect(out.duration).toBeCloseTo(2.8);expect(out.loop).toBe(false);expect(out.name).toBe('串联');expect(out.id).not.toBe(a.id);
  expect(out.keys.some(k=>Math.abs(k.time-1.4)<1e-9)).toBe(true);
  expect(Math.abs(frameAt(out,1.2,origin()).pose.lean-20)).toBeLessThan(.05);
  closePose(fk(out,0),fk(a,0));closePose(fk(out,out.duration),fk(b,b.duration));
  expect(validateDocShape(out)).toEqual([]);expect(JSON.parse(serializeDoc(out))).toStrictEqual(out);expect([serializeDoc(a),serializeDoc(b)]).toEqual(sources);
  const data=new Map<string,string>(),store={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
  const library=new MotionLibrary(rig.rest,store).load();library.add(a);library.add(b);library.add(out);
  const restored=new MotionLibrary(rig.rest,store).load({readOnly:true});
  expect(restored.docs.find(d=>d.id===out.id)).toEqual(out);expect(restored.docs.find(d=>d.id===a.id)).toEqual(a);
 });
 it('blends normalized progress and takes the longer duration; 0/100% copy their source exactly',()=>{
  const a=doc('short'),b=doc('long',2);a.keys[1].pose.lean=40;b.keys[1].pose.lean=80;
  const out=combineMotions(a,b,{kind:'blend',weight:.25},origin());
  expect(out.duration).toBe(2);
  for(const time of [0,.5,1,1.5,2])expect(frameAt(out,time,origin()).pose.lean).toBeCloseTo(.75*frameAt(a,time/2,origin()).pose.lean+.25*frameAt(b,time,origin()).pose.lean,6);
  for(const weight of [0,1]){
   const result=combineMotions(a,b,{kind:'blend',weight},origin());const source=weight===0?a:b;
   expect(result.duration).toBe(source.duration);expect(result.handFrames).toEqual(source.handFrames);
   for(const t of [0,.37,1])closePose(fk(result,t*result.duration),fk(source,t*source.duration));
  }
 });
 it('uses short angular arcs and resolves pelvis-space hands with the real rest-root',()=>{
  const a=doc('a'),b=doc('b');a.keys.forEach(k=>k.pose.yaw=170);b.keys.forEach(k=>k.pose.yaw=-170);
  b.handFrames={L:'world',R:'world'};
  const out=combineMotions(a,b,{kind:'blend',weight:.5},origin());
  const frame=frameAt(out,.5,origin());expect(Math.abs(frame.pose.yaw)).toBeCloseTo(180);
  const l=frameAt(a,.5,origin()).pose.handL.target,r=frameAt(b,.5,origin()).pose.handL.target;
  expect(frame.pose.handL.target.x).toBeCloseTo((l.x+r.x)/2,7);expect(frame.pose.handL.target.y).toBeCloseTo((l.y+r.y)/2,7);
  const h=frame.pose.handL;expect(new Vector3(h.forward.x,h.forward.y,h.forward.z).dot(new Vector3(h.normal.x,h.normal.y,h.normal.z))).toBeCloseTo(0,9);
 });
 it('re-encodes release waypoints and maintains continuous liftoff and stationary planted feet',()=>{
  const a=doc('step'),b=doc('still');
  const release=structuredClone(a.keys[0]);release.id='release';release.time=.3;release.constraints.plantL=false;release.pose.footL.target.x+=.18;release.pose.footL.target.y+=.08;
  a.keys[1].pose.footL.target.x+=.3;a.keys.splice(1,0,release);
  const out=combineMotions(a,b,{kind:'blend',weight:.5},origin());
  expect(validateDocShape(out)).toEqual([]);
  const at=(t:number)=>frameAt(out,t,origin()).pose.footL.target;
  const d=(x:number,y:number)=>new Vector3(...Object.values(at(x)) as [number,number,number]).distanceTo(new Vector3(...Object.values(at(y)) as [number,number,number]));
  expect(d(.3-1e-6,.3+1e-6)).toBeLessThan(1e-4);
  expect(at(.5).y).toBeGreaterThan(at(.3).y+.01);
  const expected=(frameAt(a,.5,origin()).pose.footL.target.x+frameAt(b,.5,origin()).pose.footL.target.x)/2;
  expect(at(.5).x).toBeCloseTo(expected,7);
  const anchor=frameAt(out,0,origin()).pose.footR;
  for(let t=0;t<=1;t+=.01)expect(frameAt(out,t,origin()).pose.footR.target).toEqual(anchor.target);
 });
 it('preserves contact events only once, chooses grip by the dominant source and supports mirrored left grip',()=>{
  const a=doc('a'),b=doc('b');a.keys.forEach(k=>k.constraints.grip=true);b.keys.forEach(k=>k.constraints.grip=true);b.keys[0].constraints.contact=true;
  const out=combineMotions(mirrorDoc(a),mirrorDoc(b),{kind:'blend',weight:.5},origin());
  expect(out.gripSide).toBe('L');expect(out.keys.filter(k=>k.constraints.contact)).toHaveLength(1);
  expect(out.keys.every(k=>k.constraints.grip)).toBe(true);
  expect(()=>combineMotions(a,mirrorDoc(b),{kind:'append',transition:.3},origin())).toThrow(/持拍侧不同/);
 });
 it('carries the grip source bevel and clears an inherited nondefault when that source uses the default facet',()=>{
  const gripDoc=(bevel?:number)=>{const d=doc('grip');d.keys.forEach(k=>k.constraints.grip=true);if(bevel!==undefined)d.gripBevel=bevel;return d;};
  // The bevel follows the doc whose grip survives (policy spreads itself onto
  // the output first), so a shaped facet on the grip source wins even when the
  // policy source carries a different one.
  expect(combineMotions(doc('p'),gripDoc(6),{kind:'append',transition:.3},origin()).gripBevel).toBe(6);
  expect(combineMotions(gripDoc(3),doc('n'),{kind:'blend',weight:.75},origin()).gripBevel).toBe(3);
  // Absent — and an explicit 1, which normalizeDoc folds back to absent — is
  // the canonical default facet: the nondefault bevel inherited from policy
  // must be cleared, not silently kept.
  const policy=doc('policy');policy.gripBevel=5;
  expect(combineMotions(policy,gripDoc(),{kind:'append',transition:.3},origin()).gripBevel).toBeUndefined();
  expect(combineMotions(gripDoc(1),policy,{kind:'blend',weight:.75},origin()).gripBevel).toBeUndefined();
  expect(validateDocShape(combineMotions(policy,gripDoc(6),{kind:'append',transition:.3},origin()))).toEqual([]);
 });
 it('rejects incompatible document policies and limits before touching either source',()=>{
  const a=doc('a',6),b=doc('b',5),before=serializeDoc(a);
  expect(()=>combineMotions(a,b,{kind:'append',transition:.3},origin())).toThrow(/10 秒上限/);
  for(const weight of [NaN,-.1,1.1])expect(()=>combineMotions(a,b,{kind:'blend',weight},origin())).toThrow(/比例/);
  for(const transition of [NaN,0,3])expect(()=>combineMotions(a,b,{kind:'append',transition},origin())).toThrow(/过渡/);
  b.freeArms=true;expect(()=>combineMotions(a,b,{kind:'blend',weight:.5},origin())).toThrow(/自由手臂/);
  expect(serializeDoc(a)).toBe(before);
  const full=doc('full');full.keys=Array.from({length:WORKSHOP_LIMITS.maxKeys},(_,i)=>({...structuredClone(full.keys[0]),id:`k${i}`,time:i/(WORKSHOP_LIMITS.maxKeys-1),constraints:{...full.keys[0].constraints,plantL:i%2===0}}));
  expect(()=>combineMotions(full,doc('other'),{kind:'append',transition:.2},origin())).toThrow(/120 个/);
 });
 it('can blend a dense combined motion again without dropping support/grip events',()=>{
  const a=doc('dense');a.keys=Array.from({length:120},(_,i)=>({...structuredClone(a.keys[0]),id:`d${i}`,time:i/119}));
  a.keys[50].constraints.grip=true;a.keys.slice(51).forEach(k=>k.constraints.grip=true);
  const b=doc('other',1.1);b.keys[1].pose.lean=30;
  const out=combineMotions(a,b,{kind:'blend',weight:.25},origin());
  expect(out.keys.length).toBeLessThanOrEqual(120);expect(validateDocShape(out)).toEqual([]);
  const event=50/119*1.1;expect(out.keys.some(k=>Math.abs(k.time-event)<1e-9&&k.constraints.grip)).toBe(true);
  expect(frameAt(out,1.1,origin()).pose.lean).toBeCloseTo(7.5,7);
 });
 it('bounds dense sampling and makes legal nonlooping output from looping sources',()=>{
  const a=doc('loop',4.8);a.loop=true;a.keys[1].time=4.7;
  const out=combineMotions(a,a,{kind:'append',transition:.2},origin());
  expect(out.duration).toBeCloseTo(9.8);expect(out.keys.length).toBeLessThanOrEqual(120);expect(out.keys.at(-1)!.time).toBe(out.duration);
  expect(validateDocShape(out)).toEqual([]);expect(flattenPose(frameAt(out,out.duration,origin()).pose).every(Number.isFinite)).toBe(true);
 });
});
