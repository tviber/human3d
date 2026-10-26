import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig,parseDoc,frameAt,solveEffectiveFrame} from '@human3d/motion-core';
import {timesForBundle,shotRole,docDigest,REVIEW_BUNDLE_REVISION} from '../scripts/lib/review-bundle.mjs';
import {verifyReviewBundleCapture,MIDPOINT_TARGET_DELTA_M} from '../scripts/lib/review-bundle-qa.mjs';
import {WRIST_RESIDUAL_FLAG_MM} from '../scripts/lib/motion-review.mjs';

/* Issue #32 review P1 regression, runnable locally (no browser): the capture
 * manifest's midpoint wrist residual must be measured against THAT frame's
 * interpolated target. The old code measured it against the nearest
 * keyframe's stored target, which at a midpoint is a different point — so a
 * perfectly solved frame reported a large residual and `init` fabricated an
 * `ik-clamp` finding. These tests build the manifest numbers from the REAL
 * solver over the issue-32 fixture in both the fixed and the buggy form, then
 * require the acceptance check to pass one and reject the other. */
const FIXTURE='evidence/issue-32/ready-swing-contact.workshop.json';

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

type Solved={wristResidualMm:number;wristTarget:number[];nearestKeyTarget:number[]};
/** Manifest `solved.right` per capture time, from the real frameAt → solve path. */
const solvedShots=(mode:'interpolated'|'nearest-key')=>{
 const doc=parseDoc(fs.readFileSync(FIXTURE,'utf8'));
 return timesForBundle(doc).map((time:number)=>{
  const frame=frameAt(doc,time,rig.rest.get('root')!);
  solveEffectiveFrame(rig,frame);
  const key=doc.keys.reduce((best,key)=>Math.abs(key.time-time)<Math.abs(best.time-time)?key:best,doc.keys[0]);
  const target=mode==='interpolated'?frame.pose.handR.target:key.pose.handR.target;
  const wrist=rig.point('wrist_R');
  return {role:shotRole(doc,time),solved:{right:{
   wristResidualMm:Math.round(wrist.distanceTo(new Vector3(target.x,target.y,target.z))*1000),
   wristTarget:mode==='interpolated'?Object.values(frame.pose.handR.target):Object.values(key.pose.handR.target),
   nearestKeyTarget:Object.values(key.pose.handR.target)}}};
 });
};

const writeBundle=(dir:string,shots:ReturnType<typeof solvedShots>,{manifestKind='workshop-review-bundle'}:{manifestKind?:string}={})=>{
 fs.mkdirSync(dir,{recursive:true});
 const doc=parseDoc(fs.readFileSync(FIXTURE,'utf8'));
 const manifest={kind:manifestKind,bundle:{revision:REVIEW_BUNDLE_REVISION,docDigest:docDigest(doc)},
  document:{id:doc.id,name:doc.name,duration:doc.duration,keys:doc.keys.length,gripSide:'R',handFrames:doc.handFrames},
  views:['front'],shots:[] as Record<string,unknown>[]};
 manifest.shots=timesForBundle(doc).map((time:number,i:number)=>{
  const file=`shot-${i}.png`;
  fs.writeFileSync(path.join(dir,file),'png-placeholder');
  return {file,time,view:'front',shotRole:shots[i].role,nearestKey:{id:'k'},solved:shots[i].solved};
 });
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
 return dir;
};

describe('review-bundle acceptance',()=>{
 it('passes a bundle whose midpoints are measured against their own interpolated target',()=>{
  const dir=writeBundle(fs.mkdtempSync(path.join(os.tmpdir(),'h3d-bundle-ok-')),solvedShots('interpolated'));
  const result=verifyReviewBundleCapture(dir);
  expect(result.shots).toBeGreaterThan(0);
  expect(result.midpoints).toBeGreaterThan(0);
  expect(result.interpolatedTargetCheck.nearestKeyTargetDeltaM).toBeGreaterThanOrEqual(MIDPOINT_TARGET_DELTA_M);
  expect(result.midpointWristResiduals.every(r=>r.mm<=WRIST_RESIDUAL_FLAG_MM)).toBe(true);
  expect(result.review.blockedAsRequired).toBe(true);
  expect(result.review.checkExit).toBe(1);
 },60000);
 it('rejects the nearest-keyframe residual as fabricated midpoint residuals and a false ik-clamp',()=>{
  const shots=solvedShots('nearest-key');
  const dir=writeBundle(fs.mkdtempSync(path.join(os.tmpdir(),'h3d-bundle-buggy-')),shots);
  const inflated=shots.filter(s=>s.role==='midpoint'&&s.solved.right.wristResidualMm>WRIST_RESIDUAL_FLAG_MM);
  expect(inflated.length, 'the buggy form must visibly inflate at least one healthy midpoint').toBeGreaterThan(0);
  expect(()=>verifyReviewBundleCapture(dir)).toThrow(/中点腕残差/);
 },60000);
 it('rejects a capture that is not a review bundle',()=>{
  const dir=writeBundle(fs.mkdtempSync(path.join(os.tmpdir(),'h3d-bundle-plain-')),solvedShots('interpolated'),{manifestKind:'plain'});
  expect(()=>verifyReviewBundleCapture(dir)).toThrow(/workshop-review-bundle/);
 });
});
