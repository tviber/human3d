import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {
 HumanRig,blankDocument,defaultDocument,frameAt,mirrorDoc,parseDoc,serializeDoc,solveEffectiveFrame,
 type WorkshopDoc,
} from '@human3d/motion-core';
import {
 readElbowAngle,readUpperArmRotation,readWristRotation,rotationControlsInSync,setElbowAngle,setUpperArmRotation,setWristRotation,
 type ArmRotationValues,type WristRotationValues,
} from './rotation-controls';

/* These tests drive the production path only: the workshop's own controller
 * functions write into the authored pose fields, and the assertion always
 * reads back a rig rebuilt by frameAt → solveEffectiveFrame. Nothing is
 * mocked, so a residual here is a residual the user would see. */

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const origin=()=>rig.rest.get('root')!;
const solve=(doc:WorkshopDoc)=>solveEffectiveFrame(rig,frameAt(doc,0,origin()));
const wrap=(degrees:number)=>((degrees%360)+540)%360-180;
const SIDES=['L','R'] as const;

describe('workshop rotation controls round-trip through the production solver',()=>{
 it('sets and reads back every upper-arm channel on both sides',()=>{
  for(const free of [false,true])for(const side of SIDES)for(const channel of ['lift','swing','twist'] as const){
   const doc=blankDocument(rig.rest,'大臂','upper');doc.freeArms=free;solve(doc);
   let reference=readUpperArmRotation(rig,side);
   for(const target of [-170,-120,-60,-20,0,25,75,120,170]){
    setUpperArmRotation(rig,doc.keys[0].pose,side,channel,target,reference);solve(doc);
    reference={...reference,[channel]:target} as ArmRotationValues;
    const read=readUpperArmRotation(rig,side,reference);
    expect(Math.abs(wrap(read[channel]-target)),`free=${free} ${side} ${channel} requested ${target}, read ${read[channel]}`).toBeLessThan(.15);
    // Only the commanded channel moves: the other two hold their readout.
    for(const other of ['lift','swing','twist'] as const)if(other!==channel)
     expect(Math.abs(wrap(read[other]-reference[other])),`${side} ${channel} disturbed ${other}`).toBeLessThan(.15);
   }
  }
 });
 it('keeps an upper-arm drag monotonically continuous across the ±90° lift singularity',()=>{
  // The solved bone orientation is continuous; a canonical YXZ decode is not,
  // so this pins the branch steering, not just the endpoints.
  for(const side of SIDES)for(const channel of ['lift','swing','twist'] as const){
   const doc=blankDocument(rig.rest,'拖拽','drag');solve(doc);
   let reference=readUpperArmRotation(rig,side),previous:number|undefined,worst=0;
   for(let value=-175;value<=175;value++){
    setUpperArmRotation(rig,doc.keys[0].pose,side,channel,value,reference);solve(doc);
    reference={...reference,[channel]:value} as ArmRotationValues;
    const read=readUpperArmRotation(rig,side,reference)[channel];
    expect(Math.abs(wrap(read-value)),`${side} ${channel} step ${value} tracked to ${read}`).toBeLessThan(.15);
    if(previous!==undefined)worst=Math.max(worst,Math.abs(wrap(read-previous)));
    previous=read;
   }
   expect(worst,`${side} ${channel} jumps during a 1° drag`).toBeLessThan(2);
  }
 });
 it('keeps the ±180° seam at the end the drag arrived from',()=>{
  // +180° and −180° are one rotation at opposite ends of the slider track, and
  // the solver leaves a small residual, so a drag pressed against −180° can
  // round to +180 — the thumb would then snap to the far end. The readout keeps
  // the end the drag arrived from.
  const step=(doc:WorkshopDoc,side:'L'|'R',channel:'lift'|'swing'|'twist',value:number,reference:ArmRotationValues)=>{
   setUpperArmRotation(rig,doc.keys[0].pose,side,channel,value,reference);solve(doc);
   return readUpperArmRotation(rig,side,{...reference,[channel]:value} as ArmRotationValues);
  };
  for(const side of SIDES)for(const channel of ['lift','swing','twist'] as const){
   const doc=blankDocument(rig.rest,'端点','seam');solve(doc);
   let reference=readUpperArmRotation(rig,side);
   for(const value of [-175,-176,-177,-178,-179,-180]){
    reference=step(doc,side,channel,value,reference);
    expect(Math.abs(reference[channel]-value),`${side} ${channel} step ${value} read ${reference[channel]}`).toBeLessThan(.25);
   }
   // No wrap here on purpose: +180 IS the failure, 360° away from −180.
   expect(reference[channel],`${side} ${channel} snapped from −180° to ${reference[channel]}°`).toBeLessThan(-179);
   const positive=blankDocument(rig.rest,'端点','seam+');solve(positive);
   let upward=readUpperArmRotation(rig,side);
   for(const value of [175,176,177,178,179,180])upward=step(positive,side,channel,value,upward);
   expect(upward[channel],`${side} ${channel} snapped from +180° to ${upward[channel]}°`).toBeGreaterThan(179);
  }
 });
 it('sets and reads back absolute elbow flexion, honouring the solver limit',()=>{
  for(const free of [false,true])for(const side of SIDES){
   const doc=blankDocument(rig.rest,'肘','elbow');doc.freeArms=free;solve(doc);
   const max=free?180:145;
   for(const target of [5,20,45,90,130,145,160,180]){
    setElbowAngle(rig,doc.keys[0].pose,side,target,max);solve(doc);
    const expected=Math.max(0,Math.min(max,target));
    expect(Math.abs(readElbowAngle(rig,side)-expected),`free=${free} ${side} requested ${target}`).toBeLessThan(.3);
   }
  }
 });
 it('keeps the elbow pivot fixed and carries the wrist, unlike a wrist edit',()=>{
  for(const side of SIDES){
   const doc=blankDocument(rig.rest,'枢纽','pivot');solve(doc);
   const elbow=rig.point(`lowerarm01_${side}`),wrist=rig.point(`wrist_${side}`);
   setElbowAngle(rig,doc.keys[0].pose,side,85,145);solve(doc);
   expect(rig.point(`lowerarm01_${side}`).distanceTo(elbow)).toBeLessThan(1e-6);
   expect(rig.point(`wrist_${side}`).distanceTo(wrist)).toBeGreaterThan(.01);
   const flexedElbow=rig.point(`lowerarm01_${side}`),flexedWrist=rig.point(`wrist_${side}`);
   // The wrist frame is expressed in the forearm's frame, so it rides along.
   setUpperArmRotation(rig,doc.keys[0].pose,side,'swing',30);solve(doc);
   expect(rig.point(`wrist_${side}`).distanceTo(flexedWrist)).toBeGreaterThan(.01);
   expect(rig.point(`lowerarm01_${side}`).distanceTo(flexedElbow)).toBeGreaterThan(.01);
  }
 });
 it('sets and reads back every wrist channel on both sides when arms are free',()=>{
  for(const side of SIDES)for(const channel of ['flex','dev','twist'] as const){
   const doc=blankDocument(rig.rest,'腕','wrist');doc.freeArms=true;solve(doc);
   let reference=readWristRotation(rig,side);
   for(let value=-170;value<=170;value+=10){
    setWristRotation(rig,doc.keys[0].pose,side,channel,value,reference);solve(doc);
    reference={...reference,[channel]:value} as WristRotationValues;
    const read=readWristRotation(rig,side,reference);
    expect(Math.abs(wrap(read[channel]-value)),`${side} ${channel} requested ${value}, read ${read[channel]}`).toBeLessThan(.2);
    for(const other of ['flex','dev','twist'] as const)if(other!==channel)
     expect(Math.abs(wrap(read[other]-reference[other])),`${side} ${channel} disturbed ${other}`).toBeLessThan(.2);
   }
  }
 });
 it('survives serialize → parse → re-solve without changing the readback',()=>{
  const cases:{name:string;channel:string;target:number;apply:(doc:WorkshopDoc,side:'L'|'R')=>Record<string,number>}[]=[
   {name:'upper swing',channel:'swing',target:-47,apply:(doc,side)=>{setUpperArmRotation(rig,doc.keys[0].pose,side,'swing',-47);solve(doc);return readUpperArmRotation(rig,side);}},
   {name:'elbow',channel:'flex',target:72,apply:(doc,side)=>{setElbowAngle(rig,doc.keys[0].pose,side,72,145);solve(doc);return {flex:readElbowAngle(rig,side)};}},
  ];
  for(const side of SIDES)for(const {name,channel,target,apply}of cases){
   const doc=blankDocument(rig.rest,name,'reload');
   // The setters transform the CURRENT solved rig into the authored pose, so the
   // rig must be solved to this key first — otherwise they would read whatever
   // the previous test left behind and the round-trip would compare garbage.
   solve(doc);
   const before=apply(doc,side);
   // Assert the edit itself landed before comparing reloads: two identically
   // wrong states would otherwise compare equal and pass silently.
   expect(Math.abs(wrap(before[channel]-target)),`${side} ${name} edit`).toBeLessThan(.15);
   const restored=parseDoc(serializeDoc(doc));
   solve(restored);
   const after=name==='elbow'?{flex:readElbowAngle(rig,side)}:readUpperArmRotation(rig,side);
   expect(after,`${side} ${name}`).toEqual(before);
  }
 });
 it('reads mirrored sides consistently: the same absolute command mirrors its sign',()=>{
  for(const channel of ['swing','twist'] as const){
   const doc=blankDocument(rig.rest,'镜像','mirror');
   solve(doc);
   setUpperArmRotation(rig,doc.keys[0].pose,'R',channel,35);solve(doc);
   const right=readUpperArmRotation(rig,'R');
   expect(Math.abs(wrap(right[channel]-35)),`R ${channel} edit`).toBeLessThan(.15);
   const mirrored=mirrorDoc(doc);
   solve(mirrored);
   const left=readUpperArmRotation(rig,'L');
   expect(Math.sign(left[channel]),`${channel} should flip sign under the x-mirror`).toBe(-Math.sign(right[channel]));
   expect(Math.abs(wrap(left[channel]+35)),`L ${channel} after mirror`).toBeLessThan(.15);
  }
 });
 it('is idempotent: writing the value it already reads back changes nothing',()=>{
  const doc=defaultDocument(rig.rest);solve(doc);
  const before=serializeDoc(doc);
  for(const side of SIDES){
   const upper=readUpperArmRotation(rig,side);
   for(const channel of ['lift','swing','twist'] as const)setUpperArmRotation(rig,doc.keys[0].pose,side,channel,upper[channel],upper);
   const wrist=readWristRotation(rig,side);
   for(const channel of ['flex','dev','twist'] as const)setWristRotation(rig,doc.keys[0].pose,side,channel,wrist[channel],wrist);
   setElbowAngle(rig,doc.keys[0].pose,side,readElbowAngle(rig,side),145);
  }
  expect(serializeDoc(doc)).toBe(before);
 });
 it('only gates the rotation sliders when the playhead is off the selected key',()=>{
  // The sliders read the rig solved at the playhead and write the selected key;
  // they may only be dragged when those are the same instant. Key times are
  // milliseconds, so the tolerance must not accept a different key.
  expect(rotationControlsInSync(.5,.5)).toBe(true);
  expect(rotationControlsInSync(0,0)).toBe(true);
  expect(rotationControlsInSync(.8000000001,.8)).toBe(true);
  expect(rotationControlsInSync(.25,.5)).toBe(false);
  expect(rotationControlsInSync(.5001,.5)).toBe(false);
  // A real document: every key is in sync with its own time, and no two keys of
  // a normal motion are close enough to be confused.
  const doc=defaultDocument(rig.rest);
  expect(doc.keys.every(k=>rotationControlsInSync(k.time,k.time))).toBe(true);
 });
});
