import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {applyHandShape,FIST_SPREAD,handJointPose,OPEN_SPREAD,RELAXED_SPREAD} from './hand-shape';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const fingerNames=(side:'L'|'R')=>Array.from({length:5},(_,finger)=>Array.from({length:3},(_,joint)=>`finger${finger+1}-${joint+1}_${side}`)).flat();
const rotations=(side:'L'|'R')=>fingerNames(side).map(name=>rig.bone(name).quaternion.toArray());

describe('hand shape channel',()=>{
 it('writes the exact legacy relaxed hand on both sides',()=>{
  for(const side of ['L','R'] as const){
   rig.reset();rig.relaxHand(side);const legacy=rotations(side);
   rig.reset();applyHandShape(rig,side,undefined);
   expect(rotations(side)).toEqual(legacy);
   rig.reset();applyHandShape(rig,side,RELAXED_SPREAD);
   expect(rotations(side)).toEqual(legacy);
  }
 });
 it('has closed-fist and open anchors with mirrored abduction',()=>{
  const fist=handJointPose('R',FIST_SPREAD),relaxed=handJointPose('R',RELAXED_SPREAD),openR=handJointPose('R',OPEN_SPREAD),openL=handJointPose('L',OPEN_SPREAD);
  expect(fist.fingers[2].mcp).toBeGreaterThan(relaxed.fingers[2].mcp);
  expect(fist.fingers[2].pip).toBeGreaterThan(relaxed.fingers[2].pip);
  expect(openR.fingers[2].abduction).toBeLessThan(0);
  expect(openL.fingers[2].abduction).toBe(-openR.fingers[2].abduction!);
  expect(openR.fingers[5].abduction).toBe(-openR.fingers[2].abduction!);
  for(const side of ['L','R'] as const){
   rig.reset();applyHandShape(rig,side,FIST_SPREAD);const closed=rotations(side);
   rig.reset();applyHandShape(rig,side,OPEN_SPREAD);const spread=rotations(side);
   expect(spread).not.toEqual(closed);
  }
 });
});
