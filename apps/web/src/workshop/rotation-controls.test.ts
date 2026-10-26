import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {
 HumanRig,blankDocument,defaultDocument,frameAt,mirrorDoc,parseDoc,serializeDoc,solveEffectiveFrame,
 type WorkshopDoc,
} from '@human3d/motion-core';
import {
 readElbowAngle,readUpperArmRotation,readWristRotation,setElbowAngle,setUpperArmRotation,setWristRotation,
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
  const cases:[string,(doc:WorkshopDoc,side:'L'|'R')=>ArmRotationValues|WristRotationValues|null][]=[
   ['upper swing',(doc,side)=>{setUpperArmRotation(rig,doc.keys[0].pose,side,'swing',-47);solve(doc);return readUpperArmRotation(rig,side);}],
   ['elbow',(doc,side)=>{setElbowAngle(rig,doc.keys[0].pose,side,72,145);solve(doc);return {flex:readElbowAngle(rig,side)} as unknown as ArmRotationValues;}],
  ];
  for(const side of SIDES)for(const [name,apply]of cases){
   const doc=blankDocument(rig.rest,name,'reload');
   const before=apply(doc,side)!;
   const restored=parseDoc(serializeDoc(doc));
   solve(restored);
   const after=name==='elbow'
    ?({flex:readElbowAngle(rig,side)} as unknown as ArmRotationValues)
    :readUpperArmRotation(rig,side);
   expect(after,`${side} ${name}`).toEqual(before);
  }
 });
 it('reads mirrored sides consistently: the same absolute command mirrors its sign',()=>{
  for(const channel of ['swing','twist'] as const){
   const doc=blankDocument(rig.rest,'镜像','mirror');
   setUpperArmRotation(rig,doc.keys[0].pose,'R',channel,35);solve(doc);
   const right=readUpperArmRotation(rig,'R')[channel];
   const mirrored=mirrorDoc(doc);
   solve(mirrored);
   const left=readUpperArmRotation(rig,'L')[channel];
   expect(Math.sign(left),`${channel} should flip sign under the x-mirror`).toBe(-Math.sign(right));
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
});
