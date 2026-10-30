import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {Euler,Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {blankDocument,compileMotion,frameAt,frameAtCompiled,mirrorDoc,parseDoc,serializeDoc,toV,validateDocShape} from './document';
import {rotateArmJoint,rotateHandFrame,solveEffectiveFrame} from './solver';
import {handFrame} from './hand-frame';
import {DEG,solveTwoBone,WRIST_BEND_LIMIT_DEG} from './kinematics';
import {subsampleDoc} from './generate';
import {probeDocument} from './quality-probe';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);
const solve=(doc:ReturnType<typeof blankDocument>)=>solveEffectiveFrame(rig,frameAt(doc,0,rig.rest.get('root')!));

describe('free arm authoring through the production sampler and solver',()=>{
 it('turns the head relative to the solved neck without moving its pivot',()=>{
  const doc=blankDocument(rig.rest,'头部朝向','head-turn');solve(doc);
  const pivot=rig.point('head');
  doc.keys[0].pose.headYaw=27;doc.keys[0].pose.headPitch=-13;solve(doc);
  const expected=new Quaternion().setFromEuler(new Euler(-13*DEG,27*DEG,0,'YXZ'));
  expect(rig.bone('head').quaternion.angleTo(expected)).toBeLessThan(1e-7);
  expect(rig.point('head').distanceTo(pivot)).toBeLessThan(1e-9);
 });
 it('preserves the policy through storage, mirror, compilation and subsampling',()=>{
  const doc=blankDocument(rig.rest,'自由关节','free-arms');doc.freeArms=true;
  const restored=parseDoc(serializeDoc(doc));
  expect(restored.freeArms).toBe(true);
  expect(mirrorDoc(mirrorDoc(restored))).toEqual(restored);
  expect(frameAtCompiled(compileMotion(restored,rig.rest.get('root')!),.5).freeArms).toBe(true);
  expect(subsampleDoc(restored,[0,.5,1],rig.rest).freeArms).toBe(true);
  expect(validateDocShape({...doc,freeArms:'yes'}).some(e=>e.includes('freeArms'))).toBe(true);
 });
 it('delivers all three wrist rotations on both sides instead of silently clamping them',()=>{
  for(const side of ['L','R'] as const)for(const kind of ['flex','dev','twist'] as const)for(const angle of [-170,-90,90,170]){
   const doc=blankDocument(rig.rest,'腕部','wrist');doc.freeArms=true;
   const h=side==='L'?doc.keys[0].pose.handL:doc.keys[0].pose.handR;
   rotateHandFrame(h,kind,angle);solve(doc);
   const q=rig.bone(`wrist_${side}`).getWorldQuaternion(new Quaternion()),rest=handFrame(rig.rest,side);
   expect(rest.forward.applyQuaternion(q).distanceTo(toV(h.forward))).toBeLessThan(1e-8);
   expect(rest.normal.applyQuaternion(q).distanceTo(toV(h.normal))).toBeLessThan(1e-8);
  }
 });
 it('rotates upper and forearm bones around their pivots over both body hemispheres',()=>{
  let behind=false,inFront=false;
  for(const side of ['L','R'] as const)for(const joint of ['upper','forearm'] as const)for(const kind of ['lift','swing','twist'] as const)for(const angle of [-150,-100,-50,50,100,150]){
   const doc=blankDocument(rig.rest,'关节','joints');doc.freeArms=true;solve(doc);
   const s=rig.point(`upperarm01_${side}`),e=rig.point(`lowerarm01_${side}`),w=rig.point(`wrist_${side}`);
   const parent=rig.bone(`upperarm01_${side}`).parent!.getWorldQuaternion(new Quaternion());
   const pivot=joint==='upper'?s:e;
   const axis=kind==='twist'?(joint==='upper'?e.clone().sub(s):w.clone().sub(e)).normalize():new Vector3(kind==='lift'?1:0,kind==='swing'?1:0,0).applyQuaternion(parent);
   const q=new Quaternion().setFromAxisAngle(axis,angle*DEG);
   const expectedW=w.clone().sub(pivot).applyQuaternion(q).add(pivot);
   const expectedE=joint==='upper'?e.clone().sub(pivot).applyQuaternion(q).add(pivot):e;
   rotateArmJoint(rig,doc.keys[0].pose,side,joint,kind,angle);solve(doc);
   expect(rig.point(`wrist_${side}`).distanceTo(expectedW)).toBeLessThan(2e-5);
   expect(rig.point(`lowerarm01_${side}`).distanceTo(expectedE)).toBeLessThan(2e-5);
   const local=rig.point(`lowerarm01_${side}`).sub(s).normalize().applyQuaternion(parent.invert());
   behind ||= local.z<-.2;inFront ||= local.z>.2;
  }
  expect(behind&&inFront).toBe(true);
 });
 it('retains the bounded default and reports the actual free wrist clamp policy',()=>{
  const doc=blankDocument(rig.rest,'限位','limits');solve(doc);
  const lower=rig.point('wrist_R').sub(rig.point('lowerarm01_R')).normalize();
  doc.keys[0].pose.handR.forward={x:-lower.x,y:-lower.y,z:-lower.z};
  const normal=new Vector3().crossVectors(lower,new Vector3(1,0,0)).normalize();
  doc.keys[0].pose.handR.normal={x:normal.x,y:normal.y,z:normal.z};
  solve(doc);
  const bounded=handFrame(rig.rest,'R').forward.applyQuaternion(rig.bone('wrist_R').getWorldQuaternion(new Quaternion()));
  expect(bounded.angleTo(lower)/DEG).toBeCloseTo(WRIST_BEND_LIMIT_DEG,6);
  doc.freeArms=true;solve(doc);
  const free=handFrame(rig.rest,'R').forward.applyQuaternion(rig.bone('wrist_R').getWorldQuaternion(new Quaternion()));
  expect(free.angleTo(lower)/DEG).toBeCloseTo(180,5);
  const report=probeDocument(rig,doc,{fps:4});
  expect(report.wristClamp.limitDeg).toBe(180);
  expect(report.wristClamp.clampedFrames).toBe(0);
 });
 it('keeps fully folded equal-length chains finite in free mode',()=>{
  const r=solveTwoBone(new Vector3(),new Vector3(),new Vector3(0,0,1),.3,.3,180);
  expect([...r.mid.toArray(),...r.end.toArray(),r.flexion].every(Number.isFinite)).toBe(true);
 });
});
