import {describe,it,expect,beforeAll} from 'vitest';
import {RACKET_TIP_LOCAL} from './props/racket';
import fs from 'node:fs';
import {Quaternion,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanRig} from './rig';
import {attachRacket,bevelDirection,bevelRoll,RACKET_BEVELS} from './props/racket';
import {gripFrame} from './grip';
import {RACKET_HANDLE} from './props/racket';
import {blankDocument,frameAt,parseDoc,serializeDoc,validateDocShape,type FootTarget,type HandTarget,type V3,type WorkshopDoc} from './document';
import {solveEffectiveFrame} from './solver';
import {canonical,normalizedRequest} from './protocol';
import {analyzeProbeFrames,probeFrames} from './quality-probe';

/** WP-D gripSide 侧别参数化 — the whole suite runs the real
 * frameAt → solveEffectiveFrame path (never a hand-rolled mirror of the
 * solver), so a passing mirror assertion means the solve itself
 * conjugates across the rig's x=0 rest plane.
 *
 * Mirror contract: the rig's rest skeleton is bilateral — every `_L`/`_R`
 * bone pair sits at mirrored rest positions with identity orientations —
 * so mirroring every doc input (hand targets/poles/frames, foot
 * targets/poles/yaw, root.x, torso yaw/chest/side) must produce a solve
 * whose positions and world orientations are the exact x-reflection of
 * the right-side solve. gripSide switches which hand wraps and mounts the
 * racket; everything else (support, feet, spine) is side-agnostic and
 * therefore identical under the swap. */

let rig:HumanRig;
beforeAll(async()=>{
 const bytes=fs.readFileSync('public/models/human.glb');
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 rig=new HumanRig(gltf.scene,JSON.parse(fs.readFileSync('public/models/rig.json','utf8')));
},30000);

const mirrorV=(v:V3):V3=>({x:-v.x,y:v.y,z:v.z});
const mirrorHand=(h:HandTarget):HandTarget=>({target:mirrorV(h.target),pole:mirrorV(h.pole),forward:mirrorV(h.forward),normal:mirrorV(h.normal)});
const mirrorFoot=(f:FootTarget):FootTarget=>({target:mirrorV(f.target),pole:mirrorV(f.pole),yaw:-f.yaw,pitch:f.pitch});
const mirrorName=(n:string)=>n.endsWith('_L')?`${n.slice(0,-2)}_R`:n.endsWith('_R')?`${n.slice(0,-2)}_L`:n;
/** Quat of the mirrored rotation M·q·M for the x-reflection M. */
const mirrorQuat=(q:Quaternion)=>new Quaternion(q.x,-q.y,-q.z,q.w);

/** A doc whose left half is the exact x-mirror of its right half — the
 * blank template is nearly symmetric already (shared root at x=0, no
 * torso twist); only the hand poles and the yaw sign need re-mirroring. */
const symmetricDoc=()=>{
 const doc=blankDocument(rig.rest,'对称握拍','sym-grip');
 for(const k of doc.keys){
  k.pose.handL=mirrorHand(k.pose.handR);
  k.pose.footL=mirrorFoot(k.pose.footR);
  k.constraints.grip=true;
 }
 return doc;
};

/** Solve one frame and capture every bone's world position + orientation. */
const solved=(doc:WorkshopDoc,t:number)=>{
 solveEffectiveFrame(rig,frameAt(doc,t,rig.rest.get('root')!));
 const pos=new Map<string,Vector3>(),quat=new Map<string,Quaternion>();
 for(const [n]of rig.bones){
  pos.set(n,rig.point(n));
  quat.set(n,rig.bone(n).getWorldQuaternion(new Quaternion()));
 }
 return {pos,quat};
};

/** Assert L equals the x-mirror of R — positions AND world orientations,
 * so finger winding, palm orientation and wrist cones are all pinned.
 * Measured residuals: ≤5e-16 m / ≤5e-8 rad — the tolerances stay
 * machine-epsilon-adjacent so the test can never certify an approximate
 * mirror as the real one (WP-D's 方案A acceptance bar). */
const expectMirror=(L:ReturnType<typeof solved>,R:ReturnType<typeof solved>,posTol=1e-9,angTol=1e-6)=>{
 for(const [n,p]of L.pos){
  const rp=R.pos.get(mirrorName(n))!;
  expect(p.distanceTo(new Vector3(-rp.x,rp.y,rp.z)),`position ${n}`).toBeLessThan(posTol);
  const q=L.quat.get(n)!;
  expect(q.angleTo(mirrorQuat(R.quat.get(mirrorName(n))!)),`orientation ${n}`).toBeLessThan(angTol);
 }
};

describe('gripSide — parse and normalize',()=>{
 it('omitted side stays the canonical absent form and solves as R',()=>{
  const doc=blankDocument(rig.rest,'t','t');
  const back=parseDoc(serializeDoc(doc));
  expect(back.gripSide).toBeUndefined();
  expect(frameAt(back,.3,rig.rest.get('root')).gripSide).toBe('R');
 });
 it('preserves an explicit L through serialize→parse',()=>{
  const doc=blankDocument(rig.rest,'t','t');doc.gripSide='L';
  const back=parseDoc(serializeDoc(doc));
  expect(back.gripSide).toBe('L');
  expect(frameAt(back,.3,rig.rest.get('root')).gripSide).toBe('L');
  // Stepped docs carry the side through the same branch.
  const stepped={...doc,inbetweens:false};
  expect(frameAt(stepped,.3,rig.rest.get('root')).gripSide).toBe('L');
 });
 it('normalizes an explicit R to the absent canonical form',()=>{
  const doc=blankDocument(rig.rest,'t','t'),raw=JSON.parse(serializeDoc(doc)) as {gripSide?:string};
  raw.gripSide='R';
  expect(parseDoc(JSON.stringify(raw)).gripSide).toBeUndefined();
 });
 it('rejects non-R/L values instead of silently keeping them',()=>{
  const doc=blankDocument(rig.rest,'t','t'),raw=JSON.parse(serializeDoc(doc)) as {gripSide?:string};
  raw.gripSide='B';
  expect(validateDocShape(raw).some(e=>e.includes('gripSide'))).toBe(true);
  expect(()=>parseDoc(JSON.stringify(raw))).toThrow();
 });
 it('folds the side into the request fingerprint, collapsing R spellings',()=>{
  const base=blankDocument(rig.rest,'t','t');
  const wire=(side?:string)=>{const raw=JSON.parse(serializeDoc(base)) as {gripSide?:string};if(side!==undefined)raw.gripSide=side;return raw;};
  const canon=(raw:object)=>canonical(normalizedRequest('workshop-doc',parseDoc(JSON.stringify(raw)),40));
  const a=canon(wire()),b=canon(wire('L')),c=canon(wire('R'));
  expect(b).not.toBe(a);   // L 与 R 解出不同轨迹 → 必须不同指纹
  expect(c).toBe(a);       // 显式 'R' 与缺省语义相同 → 归一后同指纹
 });
});

describe('gripSide — mirrored solve',()=>{
 const solveBoth=(edit:(d:WorkshopDoc)=>void,times:number[])=>{
  const doc=symmetricDoc();edit(doc);
  for(const inbetweens of [true,false]){
   const d:WorkshopDoc={...doc,inbetweens};
   for(const t of times){
    const R=solved(d,t);
    const L=solved({...d,gripSide:'L'},t);
    expectMirror(L,R);
   }
  }
 };
 it('solves a left grip as the exact x-mirror of the same right grip',()=>{
  solveBoth(()=>{},[0,.25,.5,.75,1]);
 });
 it('mirrors the wrist cone clamp when the bend exceeds the limit',()=>{
  solveBoth(d=>{
   for(const k of d.keys){
    // Low hand + straight-up desired forward ≈90° bend → the 59.8°
    // cone engages on both sides; symmetry must survive the clamp.
    k.pose.handR.target={x:-.25,y:.7,z:.35};k.pose.handR.forward={x:0,y:1,z:0};k.pose.handR.normal={x:-1,y:0,z:0};
    k.pose.handL=mirrorHand(k.pose.handR);
   }
  },[0,.5,1]);
 });
 it('mirrors clavicle assist onto the gripping side',()=>{
  solveBoth(d=>{
   d.clavicleLift=true;
   for(const k of d.keys){
    k.pose.handR.target={x:-.25,y:1.75,z:.1};
    k.pose.handL=mirrorHand(k.pose.handR);
   }
  },[0,.5,1]);
 });
 it('actually wraps the left fingers instead of leaving them relaxed',()=>{
  const doc=symmetricDoc();
  solved({...doc,gripSide:'L'},.5);
  const wrappedL=rig.point('finger1-3_L');
  solved(doc,.5);
  const relaxedL=rig.point('finger1-3_L');
  expect(wrappedL.distanceTo(relaxedL)).toBeGreaterThan(.01);
 });
 it('full grip fully owns finger rotations regardless of authored hand spread',()=>{
  const doc=symmetricDoc();
  const fingerNames=Array.from({length:5},(_,f)=>Array.from({length:3},(_,j)=>`finger${f+1}-${j+1}_R`)).flat();
  const solveSpread=(spread:number)=>{
   for(const key of doc.keys)key.pose.handSpread={...(key.pose.handSpread??{}),R:spread};
   const frame=frameAt(doc,.5,rig.rest.get('root')!);
   expect(frame.gripAmount).toBe(1);
   solveEffectiveFrame(rig,frame);
   return fingerNames.map(name=>rig.bone(name).quaternion.clone());
  };
  const fist=solveSpread(0),open=solveSpread(1);
  const maxAngle=Math.max(...fist.map((q,i)=>q.angleTo(open[i])));
  expect(maxAngle).toBeLessThan(1e-7);
 });
});

describe('gripSide — racket mount',()=>{
 it('derives the left grip frame as the mirror of the right',()=>{
  const R=gripFrame(rig,'R',RACKET_HANDLE),L=gripFrame(rig,'L',RACKET_HANDLE);
  // Polar vectors mirror x→−x; the handle axis is a cross product
  // (axial) so its mirror is (−x→x, y→−y, z→−z) — same line, opposite sense.
  for(const [a,b]of [[L.forward,R.forward],[L.normal,R.normal],[L.center,R.center]]as const){
   expect(a.x).toBeCloseTo(-b.x,9);expect(a.y).toBeCloseTo(b.y,9);expect(a.z).toBeCloseTo(b.z,9);
  }
  expect(L.axis.x).toBeCloseTo(R.axis.x,9);expect(L.axis.y).toBeCloseTo(-R.axis.y,9);expect(L.axis.z).toBeCloseTo(-R.axis.z,9);
 });
 it('bevel rolls mirror and every palm-relative direction advances by one 45° facet',()=>{
  expect(RACKET_BEVELS).toBe(8);
  for(let bevel=1;bevel<=RACKET_BEVELS;bevel++){
   const r=bevelDirection('R',bevel),l=bevelDirection('L',bevel);
   expect(l.x).toBeCloseTo(-r.x,12);expect(l.y).toBeCloseTo(r.y,12);expect(l.z).toBeCloseTo(r.z,12);
   expect(bevelRoll('L',bevel)).toBe(-bevelRoll('R',bevel));
   if(bevel<RACKET_BEVELS){
    // Azimuth maps θ→(sinθ,cosθ), so the plain (x,z) cross comes out NEGATED;
    // swap the order to measure the +45° advance from one facet to the next.
    const next=bevelDirection('R',bevel+1);
    expect(Math.atan2(next.x*r.z-next.z*r.x,r.x*next.x+r.z*next.z)).toBeCloseTo(Math.PI/4,12);
   }
  }
 });
 it('mounts nondefault bevels as the exact left/right mirror',()=>{
  const doc=symmetricDoc();
  for(const bevel of [2,4,8]){
   const rR=attachRacket(rig,'R',bevel),rL=attachRacket(rig,'L',bevel);
   solved(doc,.5);const R={tip:rR.localToWorld(RACKET_TIP_LOCAL.clone()),q:rR.getWorldQuaternion(new Quaternion()),edge:rR.localToWorld(new Vector3(.03,.45,0))};
   // The left mount is the conjugated transform, so a local probe with x≠0
   // corresponds to the x-mirrored local point on the left racket.
   solved({...doc,gripSide:'L'},.5);const L={tip:rL.localToWorld(RACKET_TIP_LOCAL.clone()),q:rL.getWorldQuaternion(new Quaternion()),edge:rL.localToWorld(new Vector3(-.03,.45,0))};
   for(const k of ['tip','edge']as const)expect(L[k].distanceTo(new Vector3(-R[k].x,R[k].y,R[k].z)),`bevel ${bevel} ${k}`).toBeLessThan(1e-9);
   expect(L.q.angleTo(mirrorQuat(R.q)),`bevel ${bevel} rotation`).toBeLessThan(1e-6);
   rR.removeFromParent();rL.removeFromParent();
  }
 });
 it('mounts on wrist_L with the mirrored transform',()=>{
  const doc=symmetricDoc();
  const rR=attachRacket(rig,'R'),rL=attachRacket(rig,'L');
  const world=(racket:typeof rR)=>({
   o:racket.getWorldPosition(new Vector3()),
   tip:racket.localToWorld(RACKET_TIP_LOCAL.clone()),
   face:racket.localToWorld(new Vector3(0,.45,.03)),
   q:racket.getWorldQuaternion(new Quaternion()),
  });
  solved(doc,.5);
  const R=world(rR);
  solved({...doc,gripSide:'L'},.5);
  expect(rL.parent?.name).toBe('wrist_L');
  const L=world(rL);
  for(const k of ['o','tip','face']as const){
   expect(L[k].distanceTo(new Vector3(-R[k].x,R[k].y,R[k].z)),`racket ${k}`).toBeLessThan(1e-9);
  }
  expect(L.q.angleTo(mirrorQuat(R.q))).toBeLessThan(1e-6);
  rR.removeFromParent();rL.removeFromParent();
 });
});

describe('gripSide — analysis',()=>{
 it('quality probe instruments the gripping arm, not the right arm',()=>{
  const doc=symmetricDoc();doc.gripSide='L';
  // Desymmetrize: a far-away left target makes arm.d discriminate which
  // side the probe instrumented (mirrored targets could not).
  for(const k of doc.keys)k.pose.handL.target={x:.55,y:.6,z:.5};
  const frames=probeFrames(rig,doc,60);
  const report=analyzeProbeFrames({doc,fps:60,frames,rest:rig.rest});
  expect(report.gripSide).toBe('L');
  expect(report.ik.armResidual.side).toBe('L');
  expect(report.chain.map(c=>c.bone)).toContain('wrist_L');
  expect(report.chain.map(c=>c.bone)).not.toContain('wrist_R');
  // arm.d is |handL.target − solved left shoulder root| — recomputed the
  // same way, at the same frame, against the same rig the probe used.
  const f=frameAt(doc,.5,rig.rest.get('root'));
  solveEffectiveFrame(rig,f);
  const arm=frames[Math.round(.5*60)].arm;
  const to=(v:Vector3,from:Vector3)=>v.distanceTo(from);
  const dL=to(rig.point('upperarm01_L'),new Vector3(f.pose.handL.target.x,f.pose.handL.target.y,f.pose.handL.target.z));
  const dR=to(rig.point('upperarm01_R'),new Vector3(f.pose.handR.target.x,f.pose.handR.target.y,f.pose.handR.target.z));
  expect(arm.d).toBeCloseTo(dL,6);
  expect(Math.abs(arm.d-dR)).toBeGreaterThan(.1);
 });
});
