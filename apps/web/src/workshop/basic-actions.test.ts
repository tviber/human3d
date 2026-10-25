import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig,WORKSHOP_LIMITS,frameAt,keyAt,motionFileById,normalizeDoc,serializeDoc,solveEffectiveFrame,validateDocShape,type WorkshopDoc} from '@human3d/motion-core';
import {basicInsertRefusal,insertBasicAction} from './basic-actions';
import {BASIC_PRESETS,OTHER_PRESETS,RACKET_PRESETS} from './library';

let rig:HumanRig;
/** Mirror of basic-actions' body-frame rotation: horizontal components turn
 * with the anchor state's yaw, vertical passes through. */
const rotY=(v:{x:number;y:number;z:number},yawDeg:number)=>{
  const yaw=yawDeg*Math.PI/180,c=Math.cos(yaw),s=Math.sin(yaw);
  return {x:v.x*c+v.z*s,y:v.y,z:-v.x*s+v.z*c};
};
// Same origin the engine passes: pelvis-frame hands resolve through the rest root.
const origin=()=>rig.rest.get('root')!;
const docOf=(id:string)=>structuredClone(motionFileById(id)!.document!) as WorkshopDoc;
const basicOf=(id:string)=>motionFileById(id)!.document!;

beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

describe('basic action library',()=>{
 it('leads with the basic actions (≤3 keys each); racket motions and older motions follow in their own groups',()=>{
  expect(BASIC_PRESETS.map(p=>p.id)).toEqual(['basic-half-squat','basic-full-squat','basic-lunge','basic-weight-shift','basic-push-turn','basic-wide-squat','basic-forward-fold','basic-arms-up']);
  for(const p of BASIC_PRESETS){
   expect(p.document!.keys.length,p.id).toBeLessThanOrEqual(3);
   expect(p.capabilities,p.id).toBeUndefined();
  }
  expect(RACKET_PRESETS.length).toBeGreaterThan(0);
  expect(RACKET_PRESETS.every(p=>p.capabilities?.prop?.kind==='racket')).toBe(true);
  expect(RACKET_PRESETS.some(p=>p.id==='forehand')).toBe(true);
  // `ready` declares the racket prop, so it sits with the racket group, not here.
  expect(OTHER_PRESETS.map(p=>p.id).sort()).toEqual(['idle','reach','squat']);
 });
});

describe('insertBasicAction',()=>{
 it('inserts a half squat at a sampled frame: starts from the state, ripples later keys, keeps the arms',()=>{
  const doc=docOf('forehand');
  const original=structuredClone(doc);
  const t=.37;
  const before=frameAt(original,t,origin());
  const span=1.6;
  const ins=insertBasicAction(doc,basicOf('basic-half-squat'),t,origin());
  expect(ins).toBeDefined();
  expect(ins!.keyIds.length).toBe(3);
  expect(ins!.span).toBeCloseTo(span,9);
  expect(doc.keys.length).toBe(original.keys.length+3);
  expect(doc.duration).toBeCloseTo(original.duration+span,9);

  const [k0,k1,k2]=ins!.keyIds.map(id=>keyAt(doc,id)!);
  expect(k0.time).toBeCloseTo(t,9);
  expect(k1.time).toBeCloseTo(t+.8,9);
  expect(k2.time).toBeCloseTo(t+1.6,9);
  // The first inserted key is the playhead state itself.
  expect(k0.pose.root.y).toBeCloseTo(before.pose.root.y,9);
  expect(k0.pose.footL.target.z).toBeCloseTo(before.pose.footL.target.z,9);
  expect(k0.pose.lean).toBeCloseTo(before.pose.lean,9);
  // The squat is a relative offset: lower root, leaning 4° further, then back to the state.
  expect(k1.pose.root.y).toBeCloseTo(k0.pose.root.y-.12,9);
  expect(k1.pose.lean).toBeCloseTo(k0.pose.lean+4,9);
  expect(k2.pose.root.y).toBeCloseTo(k0.pose.root.y,9);
  // Arms are not part of a basic action: the hands stay where the playhead left them.
  expect(k1.pose.handR).toEqual(k0.pose.handR);
  expect(k2.pose.handL).toEqual(k0.pose.handL);

  // Original keys at or after the playhead move by the span; earlier keys stay put.
  for(const k of original.keys){
   const now=keyAt(doc,k.id)!;
   if(k.time>t)expect(now.time,k.id).toBeCloseTo(k.time+span,9);
   else expect(now.time,k.id).toBeCloseTo(k.time,9);
  }
  expect(validateDocShape(doc)).toEqual([]);
  expect(() => normalizeDoc(JSON.parse(serializeDoc(doc)))).not.toThrow();
 });

 it('reuses an existing key at the playhead instead of stacking a duplicate timestamp',()=>{
  const doc=docOf('forehand');
  const anchor=doc.keys[2];
  const pose=structuredClone(anchor.pose);
  const n=doc.keys.length;
  const ins=insertBasicAction(doc,basicOf('basic-half-squat'),anchor.time+.004,origin());
  expect(ins!.keyIds[0]).toBe(anchor.id);
  expect(ins!.time).toBeCloseTo(anchor.time,9);
  expect(doc.keys.length).toBe(n+2);
  expect(keyAt(doc,anchor.id)!.pose).toEqual(pose);
  const times=doc.keys.map(k=>k.time);
  expect(new Set(times.map(x=>x.toFixed(6))).size).toBe(times.length);
  expect(validateDocShape(doc)).toEqual([]);
 });

 it('ripples dense keys after the insertion boundary, including a key only 5 ms later',()=>{
  const doc=docOf('idle');
  doc.keys=doc.keys.slice(0,2);
  doc.keys[0].time=0;doc.keys[1].time=1;doc.duration=1.2;
  const dense=structuredClone(doc.keys[0]);dense.id='dense';dense.time=.005;
  doc.keys.push(dense);doc.keys.sort((a,b)=>a.time-b.time);
  const original=structuredClone(doc.keys);
  const ins=insertBasicAction(doc,basicOf('basic-lunge'),0,origin())!;
  expect(keyAt(doc,'dense')!.time).toBeCloseTo(.005+ins.span,9);
  expect(keyAt(doc,original[2].id)!.time).toBeCloseTo(1+ins.span,9);
  expect(validateDocShape(doc)).toEqual([]);
 });

 it('lunge: the lead foot steps forward in the BODY frame, holds, and is released at the last key',()=>{
  const doc=docOf('forehand');
  const yaw=frameAt(doc,.5,origin()).pose.yaw;
  const rightBefore=frameAt(doc,.5,origin()).constraints.plantR;
  const ins=insertBasicAction(doc,basicOf('basic-lunge'),.5,origin())!;
  const [k0,k1,k2]=ins.keyIds.map(id=>keyAt(doc,id)!);
  expect(k0.constraints.plantL).toBe(false);
  expect(k1.constraints.plantL).toBe(true);
  expect(k2.constraints.plantL).toBe(false);
  // The world-axis template offsets (.24 m forward step, .02 m pelvis shift)
  // turn with the playhead state's yaw: a forehand stance at −14.7° steps
  // along its own facing.
  const step=rotY({x:0,y:0,z:.24},yaw);
  expect(k2.pose.footL.target.x-k0.pose.footL.target.x).toBeCloseTo(step.x,9);
  expect(k2.pose.footL.target.z-k0.pose.footL.target.z).toBeCloseTo(step.z,9);
  const shift=rotY({x:0,y:-.002,z:.02},yaw);
  expect(k2.pose.root.x-k0.pose.root.x).toBeCloseTo(shift.x,9);
  expect(k2.pose.root.z-k0.pose.root.z).toBeCloseTo(shift.z,9);
  expect(k2.pose.root.y-k0.pose.root.y).toBeCloseTo(-.09,9);
  // The trailing foot is not moved by the action: it keeps the state's contact.
  expect(k0.constraints.plantR).toBe(rightBefore);
  expect(k2.constraints.plantR).toBe(rightBefore);
  expect(validateDocShape(doc)).toEqual([]);
 });

 it('wide squat: the solved feet really stand wide at the half-squat key',()=>{
  // contactPlan pins a planted run to its first key's contact, so the wide
  // targets are only honest if the release boundary breaks the run. This is
  // the regression for exactly that: solved ankle positions, not targets.
  const doc=docOf('idle');
  insertBasicAction(doc,basicOf('basic-wide-squat'),0,origin())!;
  const solve=(t:number)=>{
   rig.reset();solveEffectiveFrame(rig,frameAt(doc,t,origin()));
   return {L:rig.point('foot_L').clone(),R:rig.point('foot_R').clone()};
  };
  const standing=solve(.01),wide=solve(.8),hold=solve(1.59);
  expect(standing.L.x-standing.R.x).toBeCloseTo(.27,1);
  // The authored stance (x ±.33) is reached once the new support run anchors.
  expect(wide.L.x).toBeCloseTo(.33,2);
  expect(wide.R.x).toBeCloseTo(-.33,2);
  expect(hold.L.x).toBeCloseTo(.33,2);
  expect(wide.L.x-wide.R.x).toBeGreaterThan(.6);
 });

 it('preserves a planted reused anchor when inserting a lunge',()=>{
  const doc=docOf('idle');
  const anchor=doc.keys[0];anchor.time=0;anchor.constraints.plantL=true;anchor.constraints.plantR=true;
  const original=structuredClone(anchor.constraints);
  rig.reset();solveEffectiveFrame(rig,frameAt(doc,anchor.time,origin()));
  const plantedFoot=rig.point('foot_L').clone();
  const ins=insertBasicAction(doc,basicOf('basic-lunge'),0,origin())!;
  expect(keyAt(doc,anchor.id)!.constraints).toEqual(original);
  const liftoff=keyAt(doc,ins.keyIds[0])!;
  expect(liftoff.time).toBeGreaterThan(anchor.time);
  expect(liftoff.constraints.plantL).toBe(false);
  rig.reset();solveEffectiveFrame(rig,frameAt(doc,.8,origin()));
  expect(rig.point('foot_L').distanceTo(plantedFoot)).toBeGreaterThan(.2);
  expect(validateDocShape(doc)).toEqual([]);
 });

 it('applies every basic action to every bundled motion and keeps the document valid',()=>{
  for(const basic of BASIC_PRESETS)for(const motion of [...RACKET_PRESETS,...OTHER_PRESETS]){
   const doc=docOf(motion.id);
   const n=doc.keys.length,d=doc.duration;
   const ins=insertBasicAction(doc,basic.document!,.3,origin());
   expect(ins,`${basic.id}->${motion.id}`).toBeDefined();
   const added=ins!.keyIds.length;
   expect(doc.keys.length,`${basic.id}->${motion.id}`).toBe(n+added);
   expect(doc.duration,`${basic.id}->${motion.id}`).toBeCloseTo(d+ins!.span,9);
   expect(validateDocShape(doc),`${basic.id}->${motion.id}`).toEqual([]);
  }
 });

 it('carry-hands offsets are body-relative: the same insert reaches forward at yaw 0/90/180',()=>{
  const tpl=basicOf('basic-forward-fold').keys;
  const d={x:tpl[1].pose.handL.target.x-tpl[0].pose.handL.target.x,
   y:tpl[1].pose.handL.target.y-tpl[0].pose.handL.target.y,
   z:tpl[1].pose.handL.target.z-tpl[0].pose.handL.target.z};
  for(const yawDeg of [0,90,180]){
   const doc=docOf('idle');
   doc.keys[0].pose.yaw=yawDeg; // the playhead anchor faces another way
   const before=frameAt(doc,0,origin());
   const ins=insertBasicAction(doc,basicOf('basic-forward-fold'),0,origin(),{carryHands:true})!;
   const k1=keyAt(doc,ins.keyIds[1])!;
   const turned=rotY(d,yawDeg);
   // The template's world +z reach turns with the body: forward stays forward.
   expect(k1.pose.handL.target.x-before.pose.handL.target.x).toBeCloseTo(turned.x,9);
   expect(k1.pose.handL.target.y-before.pose.handL.target.y).toBeCloseTo(turned.y,9);
   expect(k1.pose.handL.target.z-before.pose.handL.target.z).toBeCloseTo(turned.z,9);
   expect(validateDocShape(doc)).toEqual([]);
  }
 });

 it('carry-hands templates translate the hand target/pole and keep the wrist orientation',()=>{
  const doc=docOf('forehand');
  const t=.37;
  const before=frameAt(structuredClone(doc),t,origin());
  const ins=insertBasicAction(doc,basicOf('basic-arms-up'),t,origin(),{carryHands:true})!;
  const [k0,k1]=ins.keyIds.map(id=>keyAt(doc,id)!);
  // The authored offset from the template's standing start, turned into the
  // playhead state's body frame (the roger stance faces yaw ≈ −14.7°).
  const tpl=basicOf('basic-arms-up').keys;
  const handDelta=(side:'L'|'R',part:'target'|'pole')=>{
   const a=tpl[0].pose[side==='L'?'handL':'handR'][part],b=tpl[1].pose[side==='L'?'handL':'handR'][part];
   return rotY({x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},before.pose.yaw);
  };
  for(const side of ['L','R'] as const){
   const dT=handDelta(side,'target'),dP=handDelta(side,'pole');
   const h0=k0.pose[side==='L'?'handL':'handR'],h1=k1.pose[side==='L'?'handL':'handR'];
   expect(h1.target.x-h0.target.x).toBeCloseTo(dT.x,9);
   expect(h1.target.y-h0.target.y).toBeCloseTo(dT.y,9);
   expect(h1.target.z-h0.target.z).toBeCloseTo(dT.z,9);
   expect(h1.pole.x-h0.pole.x).toBeCloseTo(dP.x,9);
  }
  // Orientation is preserved verbatim, not differenced.
  expect(k1.pose.handL.forward).toEqual(k0.pose.handL.forward);
  expect(k1.pose.handR.normal).toEqual(k0.pose.handR.normal);
  expect(validateDocShape(doc)).toEqual([]);
 });

 it('without carryHands the same template leaves the hands untouched',()=>{
  const doc=docOf('idle');
  const ins=insertBasicAction(doc,basicOf('basic-arms-up'),0,origin())!;
  const [k0,k1]=ins.keyIds.map(id=>keyAt(doc,id)!);
  expect(k1.pose.handL).toEqual(k0.pose.handL);
  expect(k1.pose.handR).toEqual(k0.pose.handR);
 });

 it('refuses without touching the document when the key or duration limit would be exceeded',()=>{
  const full=docOf('forehand');
  const template=full.keys[0];
  for(let i=0;full.keys.length<WORKSHOP_LIMITS.maxKeys-1;i++){
   full.keys.push({...structuredClone(template),id:`fill-${i}`,time:.001+i*.0001,label:''});
  }
  full.keys.sort((a,b)=>a.time-b.time);
  const snapshot=serializeDoc(full);
  expect(basicInsertRefusal(full,basicOf('basic-half-squat'),1.7)).toMatch(/上限/);
  expect(insertBasicAction(full,basicOf('basic-half-squat'),1.7,origin())).toBeUndefined();
  expect(serializeDoc(full)).toBe(snapshot);

  const long=docOf('forehand');
  long.duration=9.5;
  const longSnapshot=serializeDoc(long);
  expect(basicInsertRefusal(long,basicOf('basic-half-squat'),.5)).toMatch(/时长/);
  expect(insertBasicAction(long,basicOf('basic-half-squat'),.5,origin())).toBeUndefined();
  expect(serializeDoc(long)).toBe(longSnapshot);
 });
});
