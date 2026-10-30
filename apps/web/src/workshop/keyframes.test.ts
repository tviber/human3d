import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig,blankDocument,compileMotion,contactStartKey,sampleMotion,samplePose,type WorkshopDoc} from '@human3d/motion-core';
import {copyKeyframe,keyframeInsertSlot} from './keyframes';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const plantedDoc=()=>{
 const d=blankDocument(rig.rest,'t','t');
 d.keys=[0,.5,1].map((time,i)=>({...structuredClone(d.keys[0]),id:`k${i}`,time,label:`k${i}`}));
 d.keys.forEach(k=>{k.constraints={plantL:true,plantR:true,grip:false,contact:false};});
 return d;
};
const insertCopy=(doc:WorkshopDoc,sourceIdx:number)=>{
 const keys=doc.keys.slice().sort((a,b)=>a.time-b.time);
 const slot=keyframeInsertSlot(doc,keys[sourceIdx].time,keys[sourceIdx+1]?.time);
 const copy=copyKeyframe(doc,keys[sourceIdx],slot!.time);
 doc.keys.push(copy);doc.keys.sort((a,b)=>a.time-b.time);
 return copy;
};

describe('copyKeyframe',()=>{
 it('gives a copied planted frame its own contact without changing the trajectory',()=>{
  // Replant is an ownership declaration, not a pose change: at copy time the
  // new key anchors at the same contact it would have inherited, so the
  // sampled path is identical to a plain clone with no flag.
  const withFlag=plantedDoc(),plain=plantedDoc();
  const copy=insertCopy(withFlag,1);
  expect(copy.constraints.replant).toBe(true);
  const keys=plain.keys.slice(),slot=keyframeInsertSlot(plain,keys[1].time,keys[2]?.time);
  const clone=structuredClone(keys[1]);clone.id='k1-copy';clone.time=slot!.time;
  plain.keys.push(clone);plain.keys.sort((a,b)=>a.time-b.time);
  const a=compileMotion(withFlag,rig.rest.get('root')!),b=compileMotion(plain,rig.rest.get('root')!);
  for(let i=0;i<=20;i++){
   const t=i/20*withFlag.duration;
   expect(sampleMotion(a,t)).toEqual(sampleMotion(b,t));
  }
  // The copy owns the contact at its time: the anchor resolves to the copy,
  // so writes to its stored foot are live data, not dead mid-run values.
  expect(contactStartKey(withFlag,'L',copy.time)?.id).toBe(copy.id);
  expect(contactStartKey(withFlag,'L',withFlag.keys[1].time)?.id).toBe('k0');
  const srcFoot=withFlag.keys[1].pose.footL.target.x;
  copy.pose.footL.target.x+=.1;
  expect(withFlag.keys[1].pose.footL.target.x).toBe(srcFoot);
  expect(samplePose(withFlag,copy.time,rig.rest.get('root')!).footL.target.x).toBeCloseTo(srcFoot+.1,9);
 });
 it('keeps an unplanted source free of replant',()=>{
  const d=plantedDoc();d.keys[1].constraints.plantL=false;d.keys[1].constraints.plantR=false;
  const copy=insertCopy(d,1);
  expect(copy.constraints.replant).toBeUndefined();
 });
 it('copies the effective contact, not the source key dead stored foot',()=>{
  const d=plantedDoc();
  // A mid-run key's stored foot is dead data; make it visibly stale so the
  // copy would inherit garbage if it cloned the source verbatim.
  d.keys[1].pose.footL.target.z+=.5;d.keys[1].pose.footL.yaw=33;
  const copy=insertCopy(d,1);
  const anchor=contactStartKey(d,'L',d.keys[1].time)!.pose.footL;
  expect(copy.pose.footL.target).toEqual(anchor.target);
  expect(copy.pose.footL.yaw).toBe(anchor.yaw);
  expect(copy.pose.footL.pitch).toBe(anchor.pitch);
  // The pole is live per-key data and travels with the copied key.
  expect(copy.pose.footL.pole).toEqual(d.keys[0].pose.footL.pole);
 });
});
