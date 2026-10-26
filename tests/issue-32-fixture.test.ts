import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import {Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from '@human3d/motion-core';
import {parseDoc,frameAt,solveEffectiveFrame,analyzePose,attachRacket,MOTION_FILES} from '@human3d/motion-core';
import {timesForBundle,docDigest} from '../scripts/lib/review-bundle.mjs';

/* The issue #32 DoD fixture: a brand-new ready→backswing→contact→follow→
 * recover document (authored for the review-loop demo, deliberately NOT a
 * bundled preset). This pins that the fixture stays valid through the REAL
 * production path — parseDoc → frameAt → solveEffectiveFrame → analyzePose —
 * at every review-bundle time, so the demo loop never breaks silently. */
const FIXTURE='evidence/issue-32/ready-swing-contact.workshop.json';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

describe('issue-32 fixture document',()=>{
 const raw=()=>JSON.parse(fs.readFileSync(FIXTURE,'utf8'));
 it('parses through the production document path and is not a bundled preset',()=>{
  const doc=parseDoc(JSON.stringify(raw()));
  expect(doc.id).toBe('issue32-ready-swing-contact');
  expect(doc.keys.map(k=>k.id)).toEqual(['g-ready','g-back','g-hit','g-follow','g-recover']);
  expect(MOTION_FILES.map(f=>f.id)).not.toContain(doc.id);
  expect(doc.keys[2].constraints.contact).toBe(true);
 });
 it('has a stable bundle digest that differs from the seeded forehand',()=>{
  const doc=parseDoc(JSON.stringify(raw()));
  expect(docDigest(doc)).toBe(docDigest(parseDoc(JSON.stringify(raw()))));
  expect(docDigest(doc)).not.toBe(docDigest(parseDoc(JSON.stringify({...doc,id:'forehand-workshop'}))));
 });
 it('solves clean at every review-bundle time on the real rig',()=>{
  const doc=parseDoc(JSON.stringify(raw()));
  const racket=attachRacket(rig,'R');
  for(const t of timesForBundle(doc)){
   const f=frameAt(doc,t,rig.rest.get('root')!);
   solveEffectiveFrame(rig,f);
   const nearest=doc.keys.reduce((best,key)=>Math.abs(key.time-t)<Math.abs(best.time-t)?key:best,doc.keys[0]);
   if(!doc.keys.some(key=>Math.abs(key.time-t)<1e-6)){
    const target=f.pose.handR.target,keyTarget=nearest.pose.handR.target;
    const delta=Math.hypot(target.x-keyTarget.x,target.y-keyTarget.y,target.z-keyTarget.z);
    expect(delta,`t=${t} interpolated target must differ from nearest key target`).toBeGreaterThan(.05);
    expect(rig.point('wrist_R').distanceTo(new Vector3(target.x,target.y,target.z)),`t=${t} interpolated wrist residual`).toBeLessThan(.005);
   }
   const analysis=analyzePose(rig,f.pose,f.constraints,racket);
   const bad=analysis.items.filter(i=>!i.ok);
   expect(bad,`t=${t}: ${bad.map(b=>`${b.code} ${b.detail}`).join(', ')}`).toEqual([]);
   const target=f.pose.handR.target;
   const residual=rig.point('wrist_R').distanceTo(new Vector3(target.x,target.y,target.z));
   expect(residual,`t=${t} wrist residual`).toBeLessThan(.005);
  }
  racket.removeFromParent();
 });
});
