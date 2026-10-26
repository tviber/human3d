import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import type {WorkshopDoc} from '@human3d/motion-core';
import {HumanRig,blankDocument,flattenPose,frameAt,motionFileById,RELAXED_SPREAD,sortedKeys,solveEffectiveFrame} from '@human3d/motion-core';
import {applyPoseAt,isPoseShape,PoseLibrary,type StorageLike} from './pose-library';

const docOf=(id:string)=>structuredClone(motionFileById(id)!.document!) as WorkshopDoc;
const idle=docOf('idle');
const origin={x:0,y:0,z:0};
/** An in-memory StorageLike recording writes, for persistence round-trips. */
const memoryStore=()=>{
  const map=new Map<string,string>();
  const writes:string[]=[];
  const store:StorageLike={getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v);writes.push(v);}};
  return {store,writes,map};
};

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

describe('PoseLibrary',()=>{
 it('captures a pose, persists it and reloads it across instances',()=>{
  const {store,writes}=memoryStore();
  const lib=new PoseLibrary(store).load();
  const pose=structuredClone(idle.keys[0].pose);
  const preset=lib.add('大鹏展翅',pose);
  expect(lib.presets).toHaveLength(1);
  expect(preset.name).toBe('大鹏展翅');
  expect(writes).toHaveLength(1);
  // mutate the source after capture — the preset must be an independent copy
  pose.handL.target.y=9;
  expect(preset.pose.handL.target.y).not.toBe(9);
  const reloaded=new PoseLibrary(store).load();
  expect(reloaded.presets).toHaveLength(1);
  expect(reloaded.presets[0].name).toBe('大鹏展翅');
  expect(reloaded.presets[0].pose).toEqual(idle.keys[0].pose);
 });
 it('deduplicates names and honours an empty capture name',()=>{
  const lib=new PoseLibrary(null).load();
  const a=lib.add('姿势',structuredClone(idle.keys[0].pose));
  const b=lib.add('姿势',structuredClone(idle.keys[1].pose));
  const c=lib.add('  ',structuredClone(idle.keys[1].pose));
  expect([a.name,b.name,c.name]).toEqual(['姿势','姿势 2','我的姿态']);
 });
 it('drops malformed stored entries on load instead of throwing',()=>{
  const {store}=memoryStore();
  store.setItem('kinesis-workshop-poses',JSON.stringify([
   null,42,{id:'x',name:'半截',pose:{root:{x:0}}},
   {id:'ok',name:'完整',pose:idle.keys[0].pose},
  ]));
  const lib=new PoseLibrary(store).load();
  expect(lib.presets.map(p=>p.name)).toEqual(['完整']);
  expect(isPoseShape(idle.keys[0].pose)).toBe(true);
  expect(isPoseShape({})).toBe(false);
 });
 it('rejects a malformed handSpread and drops presets carrying one on load',()=>{
  // handSpread is optional: absent (the legacy shape), an empty object (both
  // sides relaxed) and the closed/open boundaries are all storable shapes.
  const base=structuredClone(idle.keys[0].pose);
  expect(isPoseShape({...base,handSpread:{L:.2,R:.8}})).toBe(true);
  expect(isPoseShape({...base,handSpread:{}})).toBe(true);
  expect(isPoseShape({...base,handSpread:{L:0,R:1}})).toBe(true);
  const malformed:unknown[]=[null,42,'.5',[],[.5,.5],{l:.2},{L:.2,X:.5},
   {L:-.01},{R:1.01},{L:Number.NaN},{R:Number.POSITIVE_INFINITY},{L:'0.2'},{R:true}];
  for(const spread of malformed)
   expect(isPoseShape({...structuredClone(base),handSpread:spread}),`handSpread ${JSON.stringify(spread)}`).toBe(false);
  // …and load() filters such presets out instead of keeping a pose whose
  // finger channels would flatten to NaN downstream.
  const {store}=memoryStore();
  store.setItem('kinesis-workshop-poses',JSON.stringify([
   {id:'bad',name:'坏手指',pose:{...structuredClone(base),handSpread:{L:2}}},
   {id:'ok',name:'好手指',pose:{...structuredClone(base),handSpread:{L:.2,R:.8}}},
  ]));
  const lib=new PoseLibrary(store).load();
  expect(lib.presets.map(p=>p.id)).toEqual(['ok']);
  expect(lib.presets[0].pose.handSpread).toEqual({L:.2,R:.8});
 });
});

describe('applyPoseAt',()=>{
 it('replaces the pose of the key at the playhead and keeps its constraints',()=>{
  const doc=docOf('idle');
  const n0=doc.keys.length;
  const target=doc.keys[1];
  const before=structuredClone(target);
  const result=applyPoseAt(doc,structuredClone(idle.keys[2].pose),target.time,origin);
  expect(result?.result).toBe('replaced');
  expect(doc.keys).toHaveLength(n0);
  expect(target.pose).toEqual(idle.keys[2].pose);
  expect(target.constraints).toEqual(before.constraints);
  expect(target.time).toBe(before.time);
 });
 it('applying a legacy pose with no handSpread resets a prior shaped key to relaxed',()=>{
  const doc=docOf('idle');
  const key=doc.keys[1];
  // Shape the key through the real write path first: a preset carrying
  // handSpread stamps its finger shape onto the key.
  const shaped=structuredClone(key.pose);shaped.handSpread={L:.1,R:.9};
  applyPoseAt(doc,shaped,key.time,origin);
  expect(key.pose.handSpread).toEqual({L:.1,R:.9});
  // A preset captured before handSpread existed has no key at all. Absence is
  // the canonical relaxed value, so it must CLEAR the old fist/open hand —
  // not leave the shaped channels behind the way Object.assign alone would.
  const legacy=structuredClone(idle.keys[2].pose);
  delete legacy.handSpread;
  const report=applyPoseAt(doc,legacy,key.time,origin);
  expect(report?.result).toBe('replaced');
  expect(key.pose.handSpread).toBeUndefined();
  expect(flattenPose(key.pose).slice(-2)).toEqual([RELAXED_SPREAD,RELAXED_SPREAD]);
 });
 it('inserts a new key carrying the pose when the playhead is between keys',()=>{
  const doc=docOf('idle');
  const n0=doc.keys.length;
  const result=applyPoseAt(doc,structuredClone(idle.keys[0].pose),.55,origin);
  expect(result?.result).toBe('inserted');
  expect(doc.keys).toHaveLength(n0+1);
  const added=doc.keys.find(k=>Math.abs(k.time-.55)<1e-9)!;
  expect(added.pose).toEqual(idle.keys[0].pose);
 });
 it('returns undefined instead of touching the document past the key limit',()=>{
  const doc=docOf('idle');
  const fills=120-doc.keys.length;
  doc.keys.push(...Array.from({length:fills},(_,i)=>({...structuredClone(doc.keys[0]),id:`fill-${i}`,time:5+i*.0001})));
  doc.duration=10;
  const snapshot=JSON.stringify(doc);
  expect(applyPoseAt(doc,structuredClone(idle.keys[0].pose),5.5,origin)).toBeUndefined();
  expect(JSON.stringify(doc)).toBe(snapshot);
 });
 it('replacing an existing pose does not grow the key list even at the limit',()=>{
  const doc=docOf('idle');
  const n0=doc.keys.length;
  const result=applyPoseAt(doc,structuredClone(idle.keys[1].pose),doc.keys[0].time,origin);
  expect(result?.result).toBe('replaced');
  expect(doc.keys).toHaveLength(n0);
  expect(doc.keys[0].pose).toEqual(idle.keys[1].pose);
 });

 it('holds foot targets on a planted non-anchor key: the solver really keeps the support contact',()=>{
  // Regression for the contactPlan trap: idle is planted throughout, so its
  // middle keys' foot channels are pinned to the run anchor. Writing a wide
  // stance there must NOT claim the feet moved — the channels are skipped
  // and the solved ankles stay at the anchor contact. The knee pole is not
  // locked and still applies.
  const doc=docOf('idle');
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const t=doc.keys[1].time;
  const solved=(time:number)=>{
   rig.reset();solveEffectiveFrame(rig,frameAt(doc,time,origin));
   return {L:rig.point('foot_L').clone(),R:rig.point('foot_R').clone()};
  };
  const before=solved(t);
  const report=applyPoseAt(doc,wide,t,origin);
  expect(report?.result).toBe('replaced');
  expect(report?.heldFoot).toEqual(['L','R']);
  // Locked channels (target x/y/z, yaw, pitch) keep the key's own values…
  expect(doc.keys[1].pose.footL.target).toEqual(docOf('idle').keys[1].pose.footL.target);
  expect(doc.keys[1].pose.footR.yaw).toBe(docOf('idle').keys[1].pose.footR.yaw);
  expect(doc.keys[1].pose.footR.pitch).toBe(docOf('idle').keys[1].pose.footR.pitch);
  // …the editable knee pole follows the stamped pose…
  expect(doc.keys[1].pose.footL.pole.x).toBeCloseTo(wide.footL.pole.x,9);
  // …and the upper body applies.
  expect(doc.keys[1].pose.root.y).toBeCloseTo(wide.root.y,9);
  // The SOLVED feet confirm the hold: no stance change on the real rig.
  const after=solved(t);
  expect(after.L.distanceTo(before.L)).toBeLessThan(1e-4);
  expect(after.R.distanceTo(before.R)).toBeLessThan(1e-4);
 });
 it('liftoff boundary: the instant stays pinned but the written target steers the mid-swing',()=>{
  // A released key right after a planted run inherits the run contact AT its
  // instant, while interpolate() reads its stored target as the mid-swing
  // waypoint of the following interval — so the stamped target must be
  // APPLIED (it shapes the swing), with the instant still pinned.
  const doc=docOf('idle');
  doc.keys[0].constraints.plantR=false; // R free on both keys
  doc.keys[1].constraints.plantL=false; // L: planted → released (liftoff)
  doc.keys[1].constraints.plantR=false;
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const t=doc.keys[1].time;
  const nextT=sortedKeys(doc).find(k=>k.time>t)!.time,mid=(t+nextT)/2;
  const solved=(time:number)=>{
   rig.reset();solveEffectiveFrame(rig,frameAt(doc,time,origin));
   return {L:rig.point('foot_L').clone(),R:rig.point('foot_R').clone()};
  };
  const instantBefore=solved(t),midBefore=solved(mid);
  const report=applyPoseAt(doc,wide,t,origin);
  expect(report?.heldFoot).toEqual([]);
  expect(report?.liftoffFoot).toEqual(['L']);
  // The waypoint IS written (the swing after liftoff depends on it)…
  expect(doc.keys[1].pose.footL.target.x).toBeCloseTo(wide.footL.target.x,9);
  expect(doc.keys[1].pose.footL.pole.x).toBeCloseTo(wide.footL.pole.x,9);
  // …the liftoff instant stays at the old contact…
  const instantAfter=solved(t);
  expect(instantAfter.L.distanceTo(instantBefore.L)).toBeLessThan(1e-4);
  // …and the mid-swing position really moved toward the new waypoint.
  const midAfter=solved(mid);
  expect(midAfter.L.x).toBeCloseTo(wide.footL.target.x,2);
  expect(midAfter.L.distanceTo(midBefore.L)).toBeGreaterThan(.1);
  // R is free on both keys: written and effective at the key instant.
  expect(doc.keys[1].pose.footR.target.x).toBeCloseTo(wide.footR.target.x,9);
  expect(instantAfter.R.x).toBeCloseTo(wide.footR.target.x,2);
 });
 it('planted → released → free: instant pinned, half-swing follows the new waypoint',()=>{
  // The reviewer's exact shape: three keys, L planted on k0 only. Applying a
  // moving target to k1 writes the mid-swing waypoint; the regression
  // compares the HALF-SWING solved foot position before and after, not just
  // the boundary instant.
  const doc=blankDocument(rig.rest,'摆动','swing');
  doc.duration=1.2;
  doc.keys[0].time=0;doc.keys[1].time=.6;
  const k2={...structuredClone(doc.keys[1]),id:'swing-c',time:1.2};
  doc.keys.push(k2);
  doc.keys[0].pose.footL.target={x:.135,y:.07364609611413336,z:.063};
  doc.keys[0].constraints.plantR=false; // R free everywhere: keep the case on L
  doc.keys[1].constraints.plantL=false; // L: planted → released → free
  doc.keys[1].constraints.plantR=false;
  doc.keys[2].constraints.plantL=false;
  doc.keys[2].constraints.plantR=false;
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const solved=(time:number)=>{
   rig.reset();solveEffectiveFrame(rig,frameAt(doc,time,origin));
   return rig.point('foot_L').clone();
  };
  const instantBefore=solved(.6),midBefore=solved(.9);
  const report=applyPoseAt(doc,wide,.6,origin);
  expect(report?.liftoffFoot).toEqual(['L']);
  expect(report?.heldFoot).toEqual([]);
  // Instant pinned to the old contact; half-swing reaches the new waypoint.
  expect(solved(.6).distanceTo(instantBefore)).toBeLessThan(1e-4);
  expect(solved(.9).x).toBeCloseTo(wide.footL.target.x,2);
  expect(solved(.9).distanceTo(midBefore)).toBeGreaterThan(.1);
 });
 it('liftoff yaw/pitch are not stored as dead data: only the target steers the swing',()=>{
  // The waypoint rule reads the stored TARGET only; yaw/pitch stay
  // overridden by the run contact. A toe-orientation-only stamp must not be
  // written (it would change the file but never the animation) nor reported.
  const doc=docOf('idle');
  doc.keys[1].constraints.plantL=false; // L: planted → released
  const pose=structuredClone(doc.keys[1].pose);
  pose.footL.yaw+=30;pose.footL.pitch+=10; // orientation-only change
  const t=doc.keys[1].time;
  const report=applyPoseAt(doc,pose,t,origin);
  expect(report?.heldFoot).toEqual([]);
  expect(report?.liftoffFoot).toEqual([]);
  expect(doc.keys[1].pose.footL.yaw).toBe(docOf('idle').keys[1].pose.footL.yaw);
  expect(doc.keys[1].pose.footL.pitch).toBe(docOf('idle').keys[1].pose.footL.pitch);
  // A moving target on the same liftoff key still applies, with the key's
  // own orientation kept (the contact owns it).
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const report2=applyPoseAt(doc,wide,t,origin);
  expect(report2?.liftoffFoot).toEqual(['L']);
  expect(doc.keys[1].pose.footL.target.x).toBeCloseTo(wide.footL.target.x,9);
  expect(doc.keys[1].pose.footL.yaw).toBe(docOf('idle').keys[1].pose.footL.yaw);
 });
 it('tail liftoff (last key, non-loop) is held: no interval follows to steer',()=>{
  // A released key on the timeline tail has its instant pinned AND no
  // following interval for the waypoint rule — without the tail rule the L
  // side would land in liftoffFoot and the target would be dead data.
  const doc=blankDocument(rig.rest,'tail','tail');
  doc.keys[1].constraints.plantL=false; // both feet: planted → released on the tail
  doc.keys[1].constraints.plantR=false;
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const report=applyPoseAt(doc,wide,doc.keys[1].time,origin);
  expect(report?.heldFoot).toEqual(['L','R']);
  expect(report?.liftoffFoot).toEqual([]);
  expect(doc.keys[1].pose.footL.target.x).toBeCloseTo(doc.keys[0].pose.footL.target.x,9);
  expect(doc.keys[1].pose.footL.pole.x).toBeCloseTo(wide.footL.pole.x,9);
  expect(doc.keys[1].pose.footR.pole.x).toBeCloseTo(wide.footR.pole.x,9);
 });
 it('fully planted loop: key 0 is the run anchor and stays editable',()=>{
  // contactPlan forces key 0 to anchor a fully planted loop (`s<0?0:s`) —
  // writing its target re-anchors the whole run, so it must not be held
  // even though its cyclic predecessor is planted.
  const doc=blankDocument(rig.rest,'循环锚点','loop-anchor');
  doc.duration=1.2;doc.loop=true;
  expect(doc.keys.every(k=>k.constraints.plantL&&k.constraints.plantR)).toBe(true);
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const report=applyPoseAt(doc,wide,0,origin);
  expect(report?.heldFoot).toEqual([]);
  expect(report?.liftoffFoot).toEqual([]);
  expect(doc.keys[0].pose.footL.target.x).toBeCloseTo(wide.footL.target.x,9);
  rig.reset();solveEffectiveFrame(rig,frameAt(doc,0,origin));
  expect(rig.point('foot_L').x).toBeCloseTo(wide.footL.target.x,2);
  expect(rig.point('foot_R').x).toBeCloseTo(wide.footR.target.x,2);
 });
 it('writes foot targets on free feet: the solved feet take the new stance',()=>{
  // Both keys released: no support run anywhere, so the written targets are
  // the effective ones (a released key directly AFTER a planted run would
  // still inherit that run's contact — the liftoff semantics).
  const doc=docOf('idle');
  for(const k of doc.keys){k.constraints.plantL=false;k.constraints.plantR=false;}
  const wide=structuredClone(docOf('basic-wide-squat').keys[1].pose);
  const t=doc.keys[1].time;
  const report=applyPoseAt(doc,wide,t,origin);
  expect(report?.heldFoot).toEqual([]);
  rig.reset();solveEffectiveFrame(rig,frameAt(doc,t,origin));
  expect(rig.point('foot_L').x).toBeCloseTo(.33,2);
  expect(rig.point('foot_R').x).toBeCloseTo(-.33,2);
 });
});
