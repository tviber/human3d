import {beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import type {SkinnedMesh} from 'three';
import {angleAt,blankDocument,frameAt,HumanRig,LIMITS,MOTION_FILES,solveEffectiveFrame} from '@human3d/motion-core';
import type {WorkshopDoc} from '@human3d/motion-core';
import {PoseValidityChecker} from './pose-validity';

type Arm={target:{x:number;y:number;z:number};pole:{x:number;y:number;z:number}};
let rig:HumanRig,mesh:SkinnedMesh,checker:PoseValidityChecker;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
 rig.model.traverse(object=>{if((object as SkinnedMesh).isSkinnedMesh)mesh=object as SkinnedMesh;});
 checker=new PoseValidityChecker(mesh,rig);
},30000);

function solved(doc:WorkshopDoc,time=.5){
 solveEffectiveFrame(rig,frameAt(doc,time,rig.rest.get('root')!));
 rig.model.updateMatrixWorld(true);
 return checker.inspect();
}
function documentWithArms(name:string,right:Arm,left?:Arm){
 const doc=blankDocument(rig.rest,name,name.toLowerCase().replaceAll(' ','-'));
 for(const key of doc.keys){
  key.pose.handR.target={...right.target};key.pose.handR.pole={...right.pole};
  if(left){key.pose.handL.target={...left.target};key.pose.handL.pole={...left.pole};}
 }
 return doc;
}
function projectedArmGap(){
 const a0=rig.point('lowerarm01_L'),a1=rig.point('wrist_L'),b0=rig.point('lowerarm01_R'),b1=rig.point('wrist_R');
 let gap=Infinity,depth=0;
 // Dense segment sampling makes this a direct check of the visible front-view
 // overlap while retaining the corresponding solved 3D depth separation.
 for(let i=0;i<=200;i++)for(let j=0;j<=200;j++){
  const u=i/200,v=j/200;
  const ax=a0.x+(a1.x-a0.x)*u,ay=a0.y+(a1.y-a0.y)*u;
  const bx=b0.x+(b1.x-b0.x)*v,by=b0.y+(b1.y-b0.y)*v;
  const d=Math.hypot(ax-bx,ay-by);
  if(d<gap){gap=d;depth=Math.abs((a0.z+(a1.z-a0.z)*u)-(b0.z+(b1.z-b0.z)*v));}
 }
 return {gap,depth};
}
const elbowFlexion=(side:'L'|'R')=>angleAt(rig.point(`upperarm01_${side}`),rig.point(`lowerarm01_${side}`),rig.point(`wrist_${side}`));

describe('Lab pose validity on the production skinned rig',()=>{
 it('accepts crossed forearms whose front projections overlap but whose 3D surfaces remain separated',()=>{
  const report=solved(documentWithArms('Crossed arms',
   {target:{x:.05,y:1.3,z:.45},pole:{x:-.4,y:1.45,z:-.2}},
   {target:{x:-.05,y:1.3,z:.3},pole:{x:.2,y:1.45,z:.6}}));
  const projection=projectedArmGap();
  expect(projection.gap).toBeLessThan(.01);
  expect(projection.depth).toBeGreaterThan(.05);
  expect(report.status).toBe('valid');
  expect(report.intersections.map(x=>x.count)).toEqual([0,0]);
  expect(report.checks.every(check=>check.ok)).toBe(true);
 });

 it('reports a right arm swept through the chest — the pre-fix forehand follow-through shape',()=>{
  // Wrist wrapped to the far side with the elbow pole still parked behind the
  // trunk: the two-bone solve puts the elbow inside the torso while every
  // joint-limit reading stays legal, so only the surface check can see it.
  const report=solved(documentWithArms('Arm through torso',{target:{x:.3,y:1.38,z:.07},pole:{x:-.48,y:1.15,z:.11}}));
  const right=report.intersections.find(hit=>hit.side==='R')!;
  expect(report.status).toBe('invalid');
  expect(right.count).toBeGreaterThan(0);
  expect(right.bones).toContain('upperarm01_R');
  expect(right.bones.some(name=>/^spine\d+$/.test(name))).toBe(true);
  expect(right.position?.every(Number.isFinite)).toBe(true);
  expect(report.checks.every(check=>check.ok)).toBe(true);
 });

 it('keeps the shipped forehand follow-through (t=3.35 s) clear of the torso',()=>{
  // Regression for the 2026-10-20 fix: this instant used to report ~250
  // right arm–torso triangle crossings through the same sampler and solver.
  const doc=MOTION_FILES.find(m=>m.id==='forehand')!.document!;
  const report=solved(doc,3.35);
  expect(report.status).not.toBe('invalid');
  expect(report.intersections.map(x=>x.count)).toEqual([0,0]);
  expect(report.checks.every(check=>check.ok)).toBe(true);
 });

 it('keeps every bundled racket motion off the elbow clamp and clear of the torso',()=>{
  // The player presets used to fold the racket arm into the trunk (wrist
  // targets 0.14–0.17 m from the shoulder against 0.53 m of arm → the solver's
  // 145° flexion clamp). Sample every key plus a uniform grid through the real
  // frameAt → solveEffectiveFrame path and require both arms to stay below the
  // clamp, with no arm–torso surface crossing and every joint check passing.
  const racket=MOTION_FILES.filter(f=>f.kind==='workshop-motion'&&f.capabilities?.prop?.kind==='racket');
  expect(racket.map(f=>f.id)).toEqual(expect.arrayContaining(['ready','forehand']));
  for(const file of racket){
   const doc=file.document!;
   const times=new Set(doc.keys.map(k=>k.time));
   for(let i=0;i<=16;i++)times.add(doc.duration*i/16);
   for(const t of times){
    const report=solved(doc,t);
    const at=`${file.id} @${t.toFixed(3)}s`;
    for(const side of ['L','R'] as const)expect(elbowFlexion(side),`${at} elbow ${side}`).toBeLessThan(LIMITS.elbowFlexion[1]-.5);
    expect(report.intersections.map(x=>x.count),at).toEqual([0,0]);
    expect(report.checks.filter(check=>!check.ok).map(check=>check.code),at).toEqual([]);
   }
  }
 },120000);

 it('reports a shoulder direction outside the diagnostic anatomical envelope',()=>{
  const report=solved(documentWithArms('Shoulder direction limit',
   {target:{x:0,y:1.4,z:-.1},pole:{x:.5,y:1.6,z:-.3}},
   {target:{x:-.15,y:1.1,z:.25},pole:{x:-.5,y:1.2,z:.5}}));
  const shoulder=report.checks.find(check=>check.code==='shoulder-direction-R')!;
  expect(shoulder.ok).toBe(false);
  expect(shoulder.value).toBeGreaterThan(shoulder.limit);
  expect(report.status).toBe('invalid');
  expect(report.checks.filter(check=>!check.ok).map(check=>check.code)).toEqual(['shoulder-direction-R']);
 });
});
